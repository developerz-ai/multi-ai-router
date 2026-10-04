import { describe, expect, test } from "bun:test"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import {
  type CliResolution,
  createSdkConcurrency,
  createSdkInvoker,
  type SdkQueryFn,
} from "../../../src/providers"
import { readSdkRequest } from "../../../src/providers/claude-sdk/request"
import { sdkQueryStream, sdkTurn } from "./fixtures"

/**
 * `thinking` and `output_config.effort` reach the Agent SDK (docs/idea/11-anthropic-agent-sdk.md §6).
 *
 * Before, a subscription Account read neither: Claude Code's `thinking: {type: "adaptive"}` +
 * `output_config: {effort: "xhigh"}` ran at the CLI's own defaults, silently. They are now carried
 * to `query()` exactly when the client sent them, and a value the SDK does not accept is dropped
 * and reported — never a `400`, because the API-key path would have accepted the turn.
 */

const CLI: CliResolution = { ok: true, source: "platform_package", path: "/opt/claude", bytes: 1 }
const FRESH = { kind: "fresh", reason: "no-session" } as const

function body(extra: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], ...extra }),
  )
}

describe("reading thinking and effort out of the body", () => {
  test("Claude Code's shape: adaptive, summarized, xhigh", () => {
    const request = readSdkRequest(
      body({
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "xhigh" },
      }),
    )
    expect(request.thinking).toEqual({ type: "adaptive", display: "summarized" })
    expect(request.effort).toBe("xhigh")
    expect(request.ignored).toEqual([])
  })

  test("an enabled budget becomes the SDK's budgetTokens", () => {
    const request = readSdkRequest(body({ thinking: { type: "enabled", budget_tokens: 8192 } }))
    expect(request.thinking).toEqual({ type: "enabled", budgetTokens: 8192 })
  })

  test("disabled is carried, not read as absence", () => {
    expect(readSdkRequest(body({ thinking: { type: "disabled" } })).thinking).toEqual({
      type: "disabled",
    })
  })

  test("absent is null for both: the SDK keeps its own defaults", () => {
    const request = readSdkRequest(body({}))
    expect(request.thinking).toBeNull()
    expect(request.effort).toBeNull()
    expect(request.ignored).toEqual([])
  })

  test("a display the SDK does not accept drops the display, keeps the thinking", () => {
    const request = readSdkRequest(body({ thinking: { type: "adaptive", display: "updates" } }))
    expect(request.thinking).toEqual({ type: "adaptive" })
    expect(request.ignored).toEqual([{ field: "thinking.display", value: "updates" }])
  })

  test("an unknown thinking type and an unknown effort are dropped and reported, never a 400", () => {
    const request = readSdkRequest(
      body({ thinking: { type: "turbo" }, output_config: { effort: "minimal" } }),
    )
    expect(request.thinking).toBeNull()
    expect(request.effort).toBeNull()
    expect(request.ignored).toEqual([
      { field: "thinking.type", value: "turbo" },
      { field: "output_config.effort", value: "minimal" },
    ])
  })

  test("a budget that is not a positive integer is dropped; enabled still stands", () => {
    const request = readSdkRequest(body({ thinking: { type: "enabled", budget_tokens: -1 } }))
    expect(request.thinking).toEqual({ type: "enabled" })
    expect(request.ignored).toEqual([{ field: "thinking.budget_tokens", value: -1 }])
  })
})

describe("the launch carries them, and only when sent", () => {
  const THINKING_TURN = sdkTurn({
    blocks: [
      [
        { type: "thinking", thinking: "", signature: "" },
        { type: "thinking_delta", thinking: "let me see" },
      ],
      [
        { type: "text", text: "" },
        { type: "text_delta", text: "done" },
      ],
    ],
  })

  function spy() {
    const launched: Options[] = []
    const query: SdkQueryFn = ({ prompt, options }) => {
      launched.push(options)
      void (async () => {
        for await (const _ of prompt) {
          // drained, as the real SDK does
        }
      })()
      return sdkQueryStream({ turns: [THINKING_TURN] })
    }
    return { launched, query }
  }

  async function run(extra: Record<string, unknown>, ignored: unknown[] = []) {
    const s = spy()
    const invoke = createSdkInvoker({
      concurrency: createSdkConcurrency({ global: 2, perAccount: 2 }),
      runQuery: s.query,
      resolveCli: () => CLI,
      onIgnoredOption: (detail) => ignored.push(detail),
    })
    const response = await invoke({
      accountId: "a",
      configDir: "/isolated/a",
      model: "m",
      body: body({ stream: true, ...extra }),
      signal: new AbortController().signal,
      session: FRESH,
    })
    return { options: s.launched[0], sse: await response.text() }
  }

  test("thinking and effort reach query() options", async () => {
    const { options } = await run({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    })
    expect(options?.thinking).toEqual({ type: "adaptive", display: "summarized" })
    expect(options?.effort).toBe("xhigh")
  })

  test("a client that sent neither sets neither", async () => {
    const { options } = await run({})
    expect(options !== undefined && "thinking" in options).toBe(false)
    expect(options !== undefined && "effort" in options).toBe(false)
  })

  test("the isolation fields are untouched by either", async () => {
    const { options } = await run({
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
    })
    expect(options?.settingSources).toEqual([])
    expect(options?.tools).toEqual([])
    expect(options?.allowedTools).toEqual([])
  })

  test("thinking deltas still reach the client", async () => {
    const { sse } = await run({ thinking: { type: "adaptive" } })
    expect(sse).toContain('"thinking_delta"')
    expect(sse).toContain("let me see")
  })

  test("a dropped value is reported to the invoker's observer", async () => {
    const ignored: unknown[] = []
    await run({ output_config: { effort: "minimal" } }, ignored)
    expect(ignored).toEqual([{ field: "output_config.effort", value: "minimal" }])
  })
})

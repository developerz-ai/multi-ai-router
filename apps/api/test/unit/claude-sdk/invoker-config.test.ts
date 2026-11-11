import { describe, expect, test } from "bun:test"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import {
  type CliResolution,
  createSdkConcurrency,
  createSdkInvoker,
  type SdkQueryFn,
} from "../../../src/providers"
import { DENY_HOLD_TIMEOUT_SECONDS } from "../../../src/providers/claude-sdk/tools/early-stop"
import { sdkQueryStream } from "./fixtures"

/**
 * 101 finding 05.4: the deny hold was a constant no config could reach. The invoker now takes it
 * (`CLAUDE_SDK_DENY_HOLD_SECONDS`, wired by the composition root) and hands it to the `PreToolUse`
 * hook the passthrough registers; unset, the shipped 60 s stays.
 */

const CLI: CliResolution = {
  ok: true,
  source: "platform_package",
  path: "/opt/claude/claude",
  bytes: 1,
}

async function holdTimeoutFor(denyHoldMs?: number): Promise<unknown> {
  const launched: Options[] = []
  const runQuery: SdkQueryFn = ({ prompt, options }) => {
    launched.push(options)
    void (async () => {
      for await (const _ of prompt) {
        /* drained like the SDK does */
      }
    })()
    return sdkQueryStream({ turns: [] })
  }
  const invoke = createSdkInvoker({
    concurrency: createSdkConcurrency({ global: 1, perAccount: 1 }),
    runQuery,
    resolveCli: () => CLI,
    ...(denyHoldMs === undefined ? {} : { denyHoldMs }),
  })
  await invoke({
    accountId: "sub-1",
    configDir: "/data/claude/3f1c0a6e-2b7d-4a51-9c88-0d21e5b7a410",
    model: "claude-opus-5",
    body: new TextEncoder().encode(
      JSON.stringify({
        model: "claude-opus-5",
        messages: [{ role: "user", content: "ping" }],
        tools: [{ name: "weather", input_schema: { type: "object" } }],
      }),
    ),
    signal: new AbortController().signal,
    session: { kind: "fresh", reason: "no-session" },
  }).catch(() => undefined)
  return launched[0]?.hooks?.PreToolUse?.[0]?.timeout
}

describe("the deny hold is configuration", () => {
  test("unset keeps the shipped ceiling", async () => {
    expect(await holdTimeoutFor()).toBe(DENY_HOLD_TIMEOUT_SECONDS)
  })

  test("an injected hold reaches the PreToolUse hook, rounded up to whole seconds", async () => {
    expect(await holdTimeoutFor(5_000)).toBe(5)
    expect(await holdTimeoutFor(1_500)).toBe(2)
  })
})

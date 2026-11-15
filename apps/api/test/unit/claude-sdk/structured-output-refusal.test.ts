import { describe, expect, test } from "bun:test"
import type { CliResolution, SdkQueryFn } from "../../../src/providers"
import { classifySdkFailure, createSdkConcurrency, createSdkInvoker } from "../../../src/providers"
import { createFastInvoker } from "../../../src/providers/claude-fast/invoker"
import type { SdkInvocation } from "../../../src/providers/claude-sdk/invoke"
import { failoverKind } from "../../../src/services/dataplane/attempt"
import { sdkQueryStream, sdkTurn } from "./fixtures"

/**
 * developerz.ai plan 101 slice 09, finding R1: the Agent-SDK transport has no carrier for the
 * client's own structured-output constraint (`output_config.format`, or the older top-level
 * `output_format`). It used to read `output_config` for `effort` alone and launch the turn anyway,
 * so a `generateObject` caller got free prose back as a `200` — on every fast-mode fallback
 * (credential inside the refresh lead, an unresolved alias, an uncalibrated profile).
 *
 * The transport now refuses before a subprocess slot is taken, with a router-authored sentence the
 * classifier names `claude-sdk:structured-output-unsupported`: retryable (the next account may be on
 * fast mode or an API key, both of which carry it natively) and request-attributable (no breaker
 * strike, no cooldown, and two such refusals end as the typed `400` request wall).
 */

const CLI: CliResolution = {
  ok: true,
  source: "platform_package",
  path: "/opt/claude/claude",
  bytes: 1,
}
const SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
  additionalProperties: false,
}

function body(extra: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "grade this" }],
      ...extra,
    }),
  )
}

function invocation(extra: Record<string, unknown>): SdkInvocation {
  return {
    accountId: "sub-1",
    configDir: "/data/claude/sub-1",
    apiKeyId: "key",
    model: "claude-opus-5",
    body: body(extra),
    signal: new AbortController().signal,
    session: { kind: "fresh", reason: "no-session" },
  }
}

function sdk() {
  let launches = 0
  const runQuery: SdkQueryFn = ({ prompt }) => {
    launches++
    void (async () => {
      for await (const _ of prompt) {
      }
    })()
    const stream = sdkQueryStream({
      turns: [
        sdkTurn({
          blocks: [
            [
              { type: "text", text: "" },
              { type: "text_delta", text: "prose" },
            ],
          ],
        }),
      ],
    })
    return {
      [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    } as ReturnType<SdkQueryFn>
  }
  const invoke = createSdkInvoker({
    concurrency: createSdkConcurrency({ global: 2, perAccount: 2 }),
    runQuery,
    resolveCli: () => CLI,
  })
  return {
    invoke,
    get launches() {
      return launches
    },
  }
}

async function refusal(run: Promise<Response>): Promise<Error> {
  const outcome = await run.then(
    (response) => response,
    (error: unknown) => error,
  )
  if (!(outcome instanceof Error))
    throw new Error("the turn launched and answered instead of refusing")
  return outcome
}

const FORMATS: readonly [string, Record<string, unknown>][] = [
  ["output_config.format", { output_config: { format: { type: "json_schema", schema: SCHEMA } } }],
  [
    "output_config.format beside effort",
    { output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } } },
  ],
  ["top-level output_format", { output_format: { type: "json_schema", schema: SCHEMA } }],
]

describe("structured output on the Agent-SDK transport (R1)", () => {
  for (const [name, extra] of FORMATS) {
    test(`${name} is refused before a subprocess launches, typed and retryable`, async () => {
      const h = sdk()
      const error = await refusal(h.invoke(invocation(extra)))

      expect(h.launches).toBe(0)
      const { classification, clientMessage } = classifySdkFailure(error)
      expect(classification.signal).toBe("claude-sdk:structured-output-unsupported")
      expect(classification.retryable).toBe(true)
      expect(classification.requestAttributable).toBe(true)
      // No clock clears it on this pool: a one-account chain ends as the wall (failover.ts).
      expect(classification.permanentForRequest).toBe(true)
      expect(failoverKind(classification.kind, classification.status)).toBe("server-error")
      expect(clientMessage).toContain("structured output")
    })
  }

  test("a fast-mode fallback carries the refusal instead of prose", async () => {
    const h = sdk()
    const fast = createFastInvoker({
      concurrency: createSdkConcurrency({ global: 2, perAccount: 2 }),
      errorMaxBytes: 4096,
      credential: async () => null,
      resolveModel: () => null,
      sdk: h.invoke,
      fetch: async () => {
        throw new Error("fast mode must not dial for an unresolved alias")
      },
    })
    const error = await refusal(fast(invocation(FORMATS[0]?.[1] ?? {})))

    expect(h.launches).toBe(0)
    expect(classifySdkFailure(error).classification.signal).toBe(
      "claude-sdk:structured-output-unsupported",
    )
  })

  test("output_config without a format still launches, effort carried", async () => {
    const h = sdk()
    const response = await h.invoke(invocation({ output_config: { effort: "high" } }))

    expect(response.status).toBe(200)
    await response.text()
    expect(h.launches).toBe(1)
  })

  test("an explicit null format is absence, not a constraint", async () => {
    const h = sdk()
    const response = await h.invoke(
      invocation({ output_config: { format: null }, output_format: null }),
    )

    expect(response.status).toBe(200)
    await response.text()
    expect(h.launches).toBe(1)
  })
})

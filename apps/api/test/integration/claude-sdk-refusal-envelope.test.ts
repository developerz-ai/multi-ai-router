import { describe, expect, test } from "bun:test"
import { createSdkConcurrency, createSdkInvoker, type SdkInvocation } from "../../src/providers"
import { subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, post, settle } from "./harness"

/**
 * The Agent-SDK half of developerz-ai/multi-ai-router#508. `invocationFailure` is where an
 * Agent-SDK refusal enters the chain, and it used to drop the classifier token, so the request wall
 * answered `error.router.signal: null` on this transport; and its `529` rule was `server-error`, an
 * envelope-less `529` where an HTTP driver's overload answers `503 upstream_overloaded`.
 */

function fleetAnswering(failure: { result: string } | "structured") {
  const real = createSdkInvoker({
    concurrency: createSdkConcurrency({ global: 4, perAccount: 1 }),
    resolveCli: () => ({ ok: true, source: "env_override", path: "/offline/claude", bytes: 1 }),
    runQuery: ({ prompt }) => {
      void (async () => {
        for await (const _ of prompt) {
        }
      })()
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: "sess_1" }
          yield {
            type: "assistant",
            uuid: "uuid-1",
            parent_tool_use_id: null,
            message: { role: "assistant", content: [] },
          }
          if (failure !== "structured")
            yield { type: "result", subtype: "success", is_error: true, result: failure.result }
        },
      }
    },
  })
  return (invocation: SdkInvocation): Promise<Response> => real(invocation)
}

function router(failure: { result: string } | "structured", accounts = 1) {
  return harness({
    accounts: Array.from({ length: accounts }, (_, index) =>
      subscriptionAccount(`sub-${index}`, { snapshot: { priority: index } }),
    ),
    responses: [],
    maxAttempts: 3,
    failover: { overloadRetries: 0 },
    selection: { unpooledPolicy: "priority-failover" },
    invokeSdk: fleetAnswering(failure),
  })
}

const ask = async (h: ReturnType<typeof router>, extra: Record<string, unknown> = {}) => {
  const response = await h.app.request(
    "/v1/messages",
    post(
      JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hello" }],
        ...extra,
      }),
      bearer(),
    ),
  )
  await settle()
  const body = (await response.json()) as { error: { message: string; router: unknown } }
  return { response, error: body.error }
}

describe("an Agent-SDK overloaded failure", () => {
  test("answers 503 upstream_overloaded and leaves the breaker active", async () => {
    const h = router({ result: "API Error: 529 overloaded_error: Overloaded" })
    const { response, error } = await ask(h)
    expect(response.status).toBe(503)
    expect(error.message).toBe("upstream overloaded (claude-sdk:overloaded)")
    expect(error.router).toMatchObject({
      wall: "clock",
      scope: "account",
      signal: "claude-sdk:overloaded",
      retryable: true,
      reset_at: null,
    })
    expect(response.headers.get("retry-after")).not.toBeNull()
    expect(h.health.stateOf("sub-0").breaker.status).toBe("active")
  })
})

describe("an Agent-SDK chain that ends as the request wall names its signal", () => {
  test("structured output the transport cannot carry", async () => {
    const h = router("structured")
    const { response, error } = await ask(h, {
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    })
    expect(response.status).toBe(400)
    expect(response.headers.get("retry-after")).toBeNull()
    expect(error.router).toMatchObject({
      wall: "request",
      scope: "request",
      signal: "claude-sdk:structured-output-unsupported",
      retryable: false,
      reset_at: null,
      retry_after_s: null,
    })
  })

  test("the permanent extra-usage refusal", async () => {
    const h = router({
      result:
        "Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage",
    })
    const { response, error } = await ask(h)
    expect(response.status).toBe(400)
    expect(error.router).toMatchObject({
      wall: "request",
      signal: "claude-sdk:extra-usage-gated",
      retryable: false,
      retry_after_s: null,
    })
    expect(h.health.stateOf("sub-0").breaker.status).toBe("active")
  })
})

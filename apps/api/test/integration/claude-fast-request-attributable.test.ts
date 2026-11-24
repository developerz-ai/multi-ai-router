import { describe, expect, test } from "bun:test"
import { ownedInvoker } from "../../src/composition/owned-invoker"
import { createLogger } from "../../src/logging/logger"
import { createFastInvoker } from "../../src/providers/claude-fast/invoker"
import { fastRefusal } from "../../src/providers/claude-fast/response"
import { createSdkConcurrency } from "../../src/providers/claude-sdk/concurrency"
import { errorResponseFailure } from "../../src/services/dataplane/sdk-attempt-response"
import { subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, post, settle } from "./harness"

/**
 * Prod 2026-11-20, `dz-strong-llm-reviewer-pool`: one Claude subscription at 27% of its 7-day
 * window took 797 upstream `429`s in 24 h, each Anthropic's request-scoped "Third-party apps now draw
 * from your extra usage" refusal, and every one cooled the account. The classifier marks that
 * refusal `requestAttributable` (`failure-rules-quota.ts`) and the breaker skips it, but the fast
 * transport dropped the flag on its way to the failure (`sdk-attempt-response.ts`), so the breaker
 * saw a bare `429` and tripped a cooldown plus a recovery probe.
 *
 * Prod 2026-11-23: 2.70.1's fix was void. The flag rode a `WeakMap` keyed by the Response and
 * `ownedInvoker` (2.75.0) answers with another one, so these tests compose the transport exactly as
 * `composition/request-services.ts` does. 795 conversations drew the refusal seven times each.
 */

const GATED =
  "Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."
const anthropicError = (status: number, type: string, message: string) =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  })

function fastRouter(upstream: (request: Request) => Response) {
  const lines: Record<string, unknown>[] = []
  const signal = new AbortController().signal
  const lease = {
    handle: (accountId: string) => ({
      accountId,
      owner: "owner",
      generation: 1n,
      signal,
      valid: () => true,
      assert() {},
      remainingMs: () => 60_000,
    }),
  }
  const fast = createFastInvoker({
    concurrency: createSdkConcurrency({ global: 2, perAccount: 2 }),
    errorMaxBytes: 4096,
    credential: async () => ({
      accessToken: "fast-selected-account-token",
      expiresAt: Date.now() + 3_600_000,
      deviceId: "a".repeat(64),
      accountUuid: "11111111-1111-4111-8111-111111111111",
    }),
    resolveModel: (_, model) => model,
    sdk: async () => new Response("unexpected SDK fallback", { status: 500 }),
    fetch: async (request) => upstream(request),
  })
  const invokeSdk = ownedInvoker(lease, fast)
  const h = harness({
    accounts: [subscriptionAccount("sub")],
    responses: [],
    maxAttempts: 1,
    invokeSdk,
    logger: createLogger({
      level: "warn",
      write: (line) => {
        lines.push(JSON.parse(line))
      },
    }),
  })
  return { ...h, lines }
}

const messages = JSON.stringify({
  model: "claude-opus-5-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hello" }],
})

describe("a fast-transport extra-usage-gated refusal", () => {
  for (const status of [429, 400]) {
    test(`a ${status} carries requestAttributable and its signal onto the failure`, async () => {
      const { response, failure } = fastRefusal(
        anthropicError(status, "invalid_request_error", GATED),
        GATED,
      )
      const outcome = await errorResponseFailure(response, null, failure)
      if (outcome.kind !== "failure") throw new Error(`expected a failure, got ${outcome.kind}`)
      expect(outcome.failure.requestAttributable).toBe(true)
      expect(outcome.failure.permanentForRequest).toBe(true)
      expect(outcome.upstreamSignal).toBe("claude-sdk:extra-usage-gated")
    })

    test(`a ${status} leaves the account active and ends as the request wall`, async () => {
      const h = fastRouter(() => {
        const refused = anthropicError(status, "invalid_request_error", GATED)
        refused.headers.set("retry-after", "17")
        return refused
      })
      const response = await h.app.request("/v1/messages", post(messages, bearer()))
      await settle()
      // The request wall, not a 429 the client's retry policy repeats: waiting cannot clear it.
      expect(response.status).toBe(400)
      expect(response.headers.get("retry-after")).toBeNull()
      const body: unknown = await response.json()
      expect(body).toMatchObject({
        type: "error",
        error: {
          type: "invalid_request_error",
          router: { wall: "request", retryable: false, retry_after_s: null },
        },
      })
      expect(JSON.stringify(body)).not.toContain("Third-party apps")
      expect(h.health.stateOf("sub").breaker.status).toBe("active")
      const line = h.lines.find((entry) => entry.msg === "upstream attempt failed")
      expect(line?.signal).toBe("claude-sdk:extra-usage-gated")
    })
  }

  test("a genuine rate-limit 429 on the same path still cools the account", async () => {
    const h = fastRouter(() =>
      anthropicError(429, "rate_limit_error", "Number of request tokens has exceeded your limit."),
    )
    const response = await h.app.request("/v1/messages", post(messages, bearer()))
    await settle()
    expect(response.status).toBe(429)
    expect(h.health.stateOf("sub").breaker.status).toBe("cooling_down")
    const line = h.lines.find((entry) => entry.msg === "upstream attempt failed")
    expect(line?.signal).toBe("claude-sdk:api-status-429")
  })
})

test("first-party request classes survive HTTP ingress and fast transport", async () => {
  for (const [client, expected] of [
    [{ "x-claude-code-request-class": "compaction" }, "main"],
    [{ "x-claude-1p-request-class": "background-task" }, "background-task"],
    [{ "x-claude-1p-request-class": "untrusted" }, "main"],
  ] as const) {
    let received = 0
    const h = fastRouter((request) => {
      received++
      expect(request.headers.get("x-claude-1p-request-class")).toBe(expected)
      return anthropicError(400, "invalid_request_error", GATED)
    })
    const response = await h.app.request("/v1/messages", post(messages, { ...bearer(), ...client }))
    await settle()
    expect(response.status).toBe(400)
    expect(received).toBe(1)
  }
})

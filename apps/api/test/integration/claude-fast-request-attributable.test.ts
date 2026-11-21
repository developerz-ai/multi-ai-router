import { describe, expect, test } from "bun:test"
import { createLogger } from "../../src/logging/logger"
import { createFastInvoker } from "../../src/providers/claude-fast/invoker"
import { fastErrorResponse } from "../../src/providers/claude-fast/response"
import { createSdkConcurrency } from "../../src/providers/claude-sdk/concurrency"
import { EXTRA_USAGE_GATED } from "../../src/providers/claude-sdk/failure-rules-vocabulary"
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
 */

const GATED =
  "Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."
const anthropicError = (status: number, type: string, message: string) =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  })

function fastRouter(upstream: () => Response) {
  const lines: Record<string, unknown>[] = []
  const invokeSdk = createFastInvoker({
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
    fetch: async () => upstream(),
  })
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
      const safe = fastErrorResponse(anthropicError(status, "invalid_request_error", GATED), GATED)
      const outcome = await errorResponseFailure(safe, null)
      if (outcome.kind !== "failure") throw new Error(`expected a failure, got ${outcome.kind}`)
      expect(outcome.failure.requestAttributable).toBe(true)
      expect(outcome.failure).not.toHaveProperty("permanentForRequest")
      expect(outcome.upstreamSignal).toBe("claude-sdk:extra-usage-gated")
    })

    test(`a ${status} leaves the account active and the client answer unchanged`, async () => {
      const h = fastRouter(() => {
        const refused = anthropicError(status, "invalid_request_error", GATED)
        refused.headers.set("retry-after", "17")
        return refused
      })
      const response = await h.app.request("/v1/messages", post(messages, bearer()))
      await settle()
      expect(response.status).toBe(429)
      // Still the fast transport's status-shaped relay, Anthropic's wait included.
      expect(response.headers.get("retry-after")).toBe("17")
      expect(await response.json()).toEqual({
        type: "error",
        error: { type: "api_error", message: EXTRA_USAGE_GATED },
      })
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

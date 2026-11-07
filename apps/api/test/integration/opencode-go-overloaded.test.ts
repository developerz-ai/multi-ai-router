import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * Prod, 2026-11-07 00:22..01:56Z: OpenCode Go answered `429` with `Upstream request failed:
 * [overloaded] the server is overloaded; retry shortly` — its shared backend busy, not a seat's
 * limit. Read as `rate-limited`, both Go seats cooled, their recovery permits were spent, and the
 * router answered 199 requests `429 quota_exhausted` (`recovering accounts are awaiting a recovery
 * permit`) with nobody out of anything. The upstream here is a mock with that exact body.
 */

const OVERLOAD_MESSAGES = [
  "Upstream request failed: [overloaded] the server is overloaded; retry shortly",
  "Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly (after 30 s)",
]

function served(): Response {
  return Response.json({
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "glm-5.3-flash",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

function seat(id: string) {
  return {
    ...account(id, { provider: "opencode-go", cipher: CRYPTOR, billing: "subscription" }),
    dialect: "openai-chat" as const,
  }
}

const CHAT = JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] })

for (const message of OVERLOAD_MESSAGES) {
  const overloaded = () =>
    Response.json({ type: "error", error: { type: "rate_limit_error", message } }, { status: 429 })
  describe(`opencode-go backend busy (${message}): no seat is out of quota`, () => {
    test("both seats overloaded, retries spent: 503 + Retry-After, never 429, no seat cooled", async () => {
      const { app, upstream, health } = harness({
        accounts: [seat("dz1"), seat("dz2")],
        responses: [overloaded],
        failover: { overloadRetries: 1, overloadRetryBaseMs: 1 },
      })

      const res = await app.request("/v1/chat/completions", post(CHAT, bearer()))
      const body = (await res.json()) as { error: { code?: string; type?: string } }
      await settle()

      expect(res.status).toBe(503)
      expect(res.headers.get("retry-after")).not.toBeNull()
      expect(JSON.stringify(body)).toContain("upstream_overloaded")
      expect(JSON.stringify(body)).not.toContain("quota_exhausted")
      // Two seats, then one retry on the last after its wait.
      expect(upstream.calls).toHaveLength(3)
      for (const id of ["dz1", "dz2"]) {
        expect(health.stateOf(id).breaker.status).toBe("active")
        expect(health.stateOf(id).breaker.consecutiveFailures).toBe(0)
      }
    })

    test("an overloaded answer then a served one: the retry serves, 200", async () => {
      let calls = 0
      const { app, upstream, health } = harness({
        accounts: [seat("dz1")],
        responses: [() => (++calls === 1 ? overloaded() : served())],
        failover: { overloadRetries: 2, overloadRetryBaseMs: 1 },
      })

      const res = await app.request("/v1/chat/completions", post(CHAT, bearer()))
      await res.text()
      await settle()

      expect(res.status).toBe(200)
      expect(upstream.calls).toHaveLength(2)
      expect(health.stateOf("dz1").breaker.status).toBe("active")
    })

    test("the next request after an all-overloaded one is still sent upstream, not refused 429", async () => {
      let calls = 0
      const { app } = harness({
        accounts: [seat("dz1"), seat("dz2")],
        responses: [() => (++calls <= 2 ? overloaded() : served())],
        failover: { overloadRetries: 0 },
      })

      const first = await app.request("/v1/chat/completions", post(CHAT, bearer()))
      await first.text()
      await settle()
      expect(first.status).toBe(503)

      const second = await app.request("/v1/chat/completions", post(CHAT, bearer()))
      await second.text()
      expect(second.status).toBe(200)
    })

    test("Go's own seat limit is still a rate limit and still cools the seat", async () => {
      const { app, health } = harness({
        accounts: [seat("dz1")],
        responses: [
          () =>
            Response.json(
              {
                type: "error",
                error: { type: "rate_limit_error", message: "Go usage limit exceeded" },
              },
              { status: 429 },
            ),
        ],
        failover: { overloadRetries: 2, overloadRetryBaseMs: 1 },
      })

      const res = await app.request("/v1/chat/completions", post(CHAT, bearer()))
      await res.text()
      await settle()

      expect(res.status).toBe(429)
      expect(health.stateOf("dz1").breaker.status).toBe("cooling_down")
    })

    // Post-merge review of #361: the busy seat was waited out only when it happened to be asked last.
    test("one seat overloaded, the other at its own limit: the busy seat is asked again and serves", async () => {
      let calls = 0
      const goLimit = () =>
        Response.json(
          {
            type: "error",
            error: { type: "rate_limit_error", message: "Go usage limit exceeded" },
          },
          { status: 429 },
        )
      const { app, upstream } = harness({
        accounts: [seat("dz1"), seat("dz2")],
        responses: [
          () => {
            calls += 1
            return calls === 1 ? overloaded() : calls === 2 ? goLimit() : served()
          },
        ],
        failover: { overloadRetries: 1, overloadRetryBaseMs: 1 },
      })

      const res = await app.request("/v1/chat/completions", post(CHAT, bearer()))
      await res.text()
      await settle()

      expect(res.status).toBe(200)
      expect(upstream.calls).toHaveLength(3)
      expect(upstream.calls[2]?.headers.get("authorization")).toBe(
        upstream.calls[0]?.headers.get("authorization") ?? "missing",
      )
    })
  })
}

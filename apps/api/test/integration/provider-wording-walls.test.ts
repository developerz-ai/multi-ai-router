import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * Sweep 101, 10.1 + 04.1 + 10.7, end to end through the data plane: what a wording verdict does to
 * the account and to the client. Upstreams are mocks answering the prod shapes (redacted).
 */

/** Prod, kimi account `80dfa451`, 2026-11-09..10: 5 parks at `exhausted`, 28 client `402`s. */
function kimiWeekly429(): Response {
  return Response.json(
    {
      type: "error",
      error: {
        type: "exceeded_current_quota_error",
        message:
          "You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription",
      },
    },
    { status: 429 },
  )
}

function kimi(id: string) {
  return { ...account(id, { provider: "kimi", cipher: CRYPTOR }), dialect: "anthropic" as const }
}

describe("10.1 — Kimi's weekly window is a cooldown, never a 402", () => {
  test("client gets 429 + Retry-After, the row is quota_exhausted, the account cools instead of parking", async () => {
    const { app, usage, health } = harness({ accounts: [kimi("k1")], responses: [kimiWeekly429] })

    const res = await app.request("/v1/messages", post(undefined, bearer()))
    const body = await res.text()
    await settle()

    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).not.toBeNull()
    expect(body).not.toContain("credits_exhausted")
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]?.outcome).toBe("quota_exhausted")
    expect(health.stateOf("k1").breaker.status).toBe("cooling_down")
  })
})

describe("04.1 — an upstream echoing the client's model name parks nothing", () => {
  test("anthropic-api 404 `model: credit balance is too low`: client error, account stays active", async () => {
    const echo = () =>
      Response.json(
        {
          type: "error",
          error: { type: "not_found_error", message: "model: credit balance is too low" },
        },
        { status: 404 },
      )
    const { app, usage, health, upstream } = harness({
      accounts: [account("a1", { cipher: CRYPTOR }), account("a2", { cipher: CRYPTOR })],
      responses: [echo],
    })

    const res = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({
          model: "credit balance is too low",
          max_tokens: 8,
          messages: [{ role: "user", content: "hi" }],
        }),
        bearer(),
      ),
    )
    await res.text()
    await settle()

    expect(res.status).toBe(404)
    // A bad request is bad at every account: the chain stops at the first, and parks neither.
    expect(upstream.calls).toHaveLength(1)
    expect(usage.rows.map((row) => row.outcome)).toEqual(["client_error"])
    for (const id of ["a1", "a2"]) expect(health.stateOf(id).breaker.status).toBe("active")
  })
})

describe("10.7 — an opencode-go key the plan does not cover is never answered as a 502", () => {
  function seat(id: string) {
    return {
      ...account(id, { provider: "opencode-go", cipher: CRYPTOR, billing: "subscription" }),
      dialect: "openai-chat" as const,
    }
  }
  const notEntitled = () =>
    Response.json(
      {
        error: {
          type: "permission_error",
          message:
            "Go Teams covers workspace members, not service accounts. Use a personal API key to call Go models.",
        },
      },
      { status: 403 },
    )

  test("the seat is parked for a human and the client is not told the credential failed", async () => {
    const { app, health } = harness({ accounts: [seat("go1")], responses: [notEntitled] })

    const res = await app.request(
      "/v1/chat/completions",
      post(
        JSON.stringify({ model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] }),
        bearer(),
      ),
    )
    const body = await res.text()
    await settle()

    expect(res.status).not.toBe(502)
    expect(body).not.toContain("upstream_auth")
    expect(health.stateOf("go1").breaker.status).toBe("exhausted")
  })
})

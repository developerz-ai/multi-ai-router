import { describe, expect, test } from "bun:test"
import { account, NOW } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post } from "./harness"

/**
 * Prod, 2026-11-23 (#441): `openrouter-dz-coding-30d` hit its daily key cap at 17:00Z. OpenRouter
 * refuses a request the cap's remainder cannot cover, so the `402` landed while `GET /api/v1/key`
 * still read under 100 %; the account parked `exhausted` and clients were told `402 needs a top-up`
 * until 03:03Z, three hours past the cap's own 00:00Z reset.
 *
 * Two refusals, one status, opposite walls, and the review of #504 asked for both through the data
 * plane: a `402` that names the resetting key cap is a clock (`429` + `Retry-After`, a cooldown
 * ending at the cap's reset), and a `402` that names the prepaid balance on that very same key is a
 * human's (`402`, `exhausted`, no clock). Upstream mocked; the reading is folded as
 * `plan_quota_read` folds it.
 */

const MODEL = "tencent/hy4-flash"
const HOUR = 3_600_000
/** The cap's next boundary, seven hours out, as `nextKeyLimitReset` would state it. */
const CAP_RESET = new Date(NOW.getTime() + 7 * HOUR)
/** Two `plan_quota_read` intervals, as `composition/warm-state.ts` derives it. */
const READING_MAX_AGE_MS = 30 * 60_000

const chat = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "fix the bug" }] })

/** The cap refusing a request it cannot cover: the sentence names a resetting key limit. */
function capRefusal(): Response {
  return Response.json(
    {
      error: {
        code: 402,
        message:
          "This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 1200. To increase, visit https://openrouter.ai/settings/keys and create a key with a higher daily limit",
      },
    },
    { status: 402 },
  )
}

/** The account's prepaid balance is empty: nothing in it names the key or its cap. */
function balanceRefusal(): Response {
  return Response.json(
    {
      error: {
        code: 402,
        message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
      },
    },
    { status: 402 },
  )
}

function ok(): Response {
  return Response.json({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
  })
}

/** One OpenRouter account whose key reads 97 % of a daily cap, ten minutes ago. */
function setup(responses: (() => Response)[], utilization = 0.97) {
  const h = harness({
    accounts: [account("or", { provider: "openrouter", cipher: CRYPTOR })],
    responses,
    health: { planReadingMaxAgeMs: READING_MAX_AGE_MS },
  })
  h.health.applyRateLimit(
    "or",
    {
      limited: false,
      resetSource: "unknown",
      windows: [],
      quotaWindows: [
        {
          window: "spend_limit",
          utilization,
          utilizationSource: "continuous",
          resetsAt: CAP_RESET,
          resetSource: "provider-reported",
          lastCheckedAt: new Date(NOW.getTime() - 10 * 60_000),
          advisory: true,
        },
      ],
    },
    NOW,
  )
  return h
}

const send = (app: ReturnType<typeof harness>["app"]) =>
  app.request("/v1/chat/completions", post(chat, bearer()))

describe("an OpenRouter 402 on a key at 97 % of its daily cap", () => {
  test("naming the cap: the client is told 429 with a Retry-After, and the account cools until the cap resets", async () => {
    const { app, health, upstream, usage } = setup([capRefusal, ok])

    const refused = await send(app)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0)
    await refused.text()

    const breaker = health.stateOf("or").breaker
    expect(breaker.status).toBe("cooling_down")
    expect(breaker.cooldownUntil).toEqual(CAP_RESET)
    expect(breaker.cooldownSource).toBe("provider-reported")
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      accountId: "or",
      httpStatus: 402,
      outcome: "quota_exhausted",
    })

    // Nothing is sent into the cap again: the router answers for it, with the cap's own clock.
    const held = await send(app)
    expect(held.status).toBe(429)
    expect(Number(held.headers.get("retry-after"))).toBe(7 * 3_600)
    await held.text()
    expect(upstream.calls).toHaveLength(1)
  })

  test("naming the balance: the client is told 402, and the account is exhausted with no clock", async () => {
    const { app, health, upstream, usage } = setup([balanceRefusal, ok])

    const refused = await send(app)
    expect(refused.status).toBe(402)
    expect(refused.headers.get("retry-after")).toBeNull()
    await refused.text()

    const breaker = health.stateOf("or").breaker
    expect(breaker.status).toBe("exhausted")
    expect(breaker.cooldownUntil).toBeUndefined()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      accountId: "or",
      httpStatus: 402,
      outcome: "credits_exhausted",
    })

    // Still a wall a human clears: no request is routed to it, and no reset is invented.
    const held = await send(app)
    expect(held.status).toBe(402)
    expect(held.headers.get("retry-after")).toBeNull()
    await held.text()
    expect(upstream.calls).toHaveLength(1)
  })

  // The driver flags this one `keyCap` and leaves it `credits-exhausted`: the sentence names the
  // key's limit and no window. The reading knows the cap resets daily, so the breaker and the
  // client's very first answer must agree it is a clock (`plan-reset.ts`, `keyCapResetFor`).
  test("naming the key's limit with no window: 429 from the first answer, on the cap's own clock", async () => {
    const keyLimit = () =>
      Response.json(
        {
          error: {
            code: 403,
            message: "Key limit exceeded. Manage it using https://openrouter.ai/settings/keys",
          },
        },
        { status: 403 },
      )
    const { app, health, upstream } = setup([keyLimit, ok])

    const refused = await send(app)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get("retry-after"))).toBe(7 * 3_600)
    await refused.text()

    const breaker = health.stateOf("or").breaker
    expect(breaker.status).toBe("cooling_down")
    expect(breaker.cooldownUntil).toEqual(CAP_RESET)

    const held = await send(app)
    expect(held.status).toBe(429)
    await held.text()
    expect(upstream.calls).toHaveLength(1)
  })

  // Review of #506: at 100 % the balance refusal still borrowed the cap's reset. Midnight refills
  // the cap, never the balance, so the cooldown ended in the same refusal.
  test("naming the balance with the cap fully spent: still 402, exhausted, no clock", async () => {
    const { app, health, upstream } = setup([balanceRefusal, ok], 1)

    const refused = await send(app)
    expect(refused.status).toBe(402)
    expect(refused.headers.get("retry-after")).toBeNull()
    await refused.text()

    const breaker = health.stateOf("or").breaker
    expect(breaker.status).toBe("exhausted")
    expect(breaker.cooldownUntil).toBeUndefined()

    const held = await send(app)
    expect(held.status).toBe(402)
    expect(held.headers.get("retry-after")).toBeNull()
    await held.text()
    expect(upstream.calls).toHaveLength(1)
  })

  test("the balance as limit_source states it, in neutral words on a 403: 402, exhausted", async () => {
    const stated = () =>
      Response.json(
        {
          error: {
            message: "Request could not be completed",
            metadata: { limit_source: "openrouter_credits" },
          },
        },
        { status: 403 },
      )
    const { app, health } = setup([stated, ok], 1)

    const refused = await send(app)
    expect(refused.status).toBe(402)
    expect(refused.headers.get("retry-after")).toBeNull()
    await refused.text()
    expect(health.stateOf("or").breaker.status).toBe("exhausted")
  })

  test("with the cap well short of spent, even the cap's own sentence borrows no reset", async () => {
    const { app, health } = setup([capRefusal, ok], 0.4)

    const refused = await send(app)
    expect(refused.status).toBe(429)
    await refused.text()

    // The driver's own estimated re-test stands; the reading lent nothing.
    const breaker = health.stateOf("or").breaker
    expect(breaker.status).toBe("cooling_down")
    expect(breaker.cooldownUntil).not.toEqual(CAP_RESET)
    expect(breaker.cooldownSource).toBe("estimated")
  })
})

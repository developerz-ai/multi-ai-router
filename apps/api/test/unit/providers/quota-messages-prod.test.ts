import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { response } from "./fixtures"

/**
 * Quota bodies exactly as production received them on 2026-10-04, one per vendor, so a rule that
 * drifts away from the live wording fails here rather than parking an account under the wrong
 * state. CLAUDE.md non-negotiable 7 is the contract: a window a clock reopens is `rate-limited`
 * (cooling_down, 429 + Retry-After); a spend cap only a human lifts is `credits-exhausted` (402).
 */

const kimi = httpDriver("kimi")
const openrouter = httpDriver("openrouter")
const zai = httpDriver("zai")

describe("kimi weekly window, 403 permission_error", () => {
  const body = {
    error: {
      type: "permission_error",
      message:
        "You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota",
    },
    type: "error",
  }

  test("is a cooldown with an estimated reset, never auth and never exhausted", () => {
    const result = kimi?.classifyFailure(response(403, { body }))

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("kimi:usage-limit-weekly")
    expect(result?.rateLimit?.resetSource).toBe("estimated")
    expect(result?.rateLimit?.retryAfterSeconds).toBeGreaterThan(0)
  })
})

describe("openrouter key limit, 403", () => {
  const message = (limit: string) =>
    `Key limit exceeded (${limit} limit). Manage it using https://openrouter.ai/workspaces/default/keys/0000000000000000000000000000000000000000000000000000000000000000`

  test("a total key limit is a spend cap a human lifts: exhausted, not auth", () => {
    const result = openrouter?.classifyFailure(
      response(403, { body: { error: { message: message("total"), code: 403 } } }),
    )

    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.signal).toBe("openrouter:key-limit")
  })

  test("a key limit naming no window is treated as the total one", () => {
    const result = openrouter?.classifyFailure(
      response(403, { body: { error: { message: "Key limit exceeded", code: 403 } } }),
    )

    expect(result?.kind).toBe("credits-exhausted")
  })

  test("a daily, weekly or monthly key limit resets on a clock: a cooldown", () => {
    for (const window of ["daily", "weekly", "monthly"]) {
      const result = openrouter?.classifyFailure(
        response(403, { body: { error: { message: message(window), code: 403 } } }),
      )

      expect(result?.kind).toBe("rate-limited")
      expect(result?.signal).toBe("openrouter:key-limit-window")
      expect(result?.rateLimit?.resetSource).toBe("estimated")
    }
  })

  test("a 403 that is not a key limit keeps its own reading", () => {
    const result = openrouter?.classifyFailure(
      response(403, { body: { error: { message: "Forbidden", code: 403 } } }),
    )

    expect(result?.kind).toBe("auth")
  })
})

describe("zai 1310, 429", () => {
  const body = {
    type: "error",
    error: {
      type: "rate_limit_error",
      code: "1310",
      message:
        "[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-06 10:02:31][2026100505515534548c930d2f4929]",
    },
  }

  test("is a cooldown whose reset is the stated instant, read as UTC+8", () => {
    const result = zai?.classifyFailure(response(429, { body }))

    expect(result?.kind).toBe("rate-limited")
    expect(result?.signal).toBe("zai:window-exhausted")
    // 2026-10-06 10:02:31 Asia/Shanghai — the request id's 20261005 055155 prefix against the
    // 2026-10-04T21:51:55Z log line is the same eight-hour lead the driver pins.
    expect(result?.rateLimit?.resetsAt?.toISOString()).toBe("2026-10-06T02:02:31.000Z")
    expect(result?.rateLimit?.resetSource).toBe("provider-reported")
  })
})

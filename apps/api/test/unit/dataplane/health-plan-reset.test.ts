import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { createHealthStore } from "../../../src/services/dataplane"

/**
 * The prod fingerprint end to end through the health store, 2026-11-06: the `minimax` account's
 * plan read said weekly spent until 2026-11-09T00:00Z, and every `2056` still cooled it for five
 * estimated minutes. With the reading held, the next refusal cools it until that reset.
 */

const READ_AT = new Date("2026-11-06T23:02:36.000Z")
const REFUSED_AT = new Date("2026-11-06T23:05:00.000Z")
const WEEKLY_RESET = new Date("2026-11-09T00:00:00.000Z")

const spentWeekly = {
  base_resp: { status_code: 0 },
  model_remains: [
    {
      model_name: "general",
      end_time: 1794009600000,
      current_interval_status: 1,
      current_interval_remaining_percent: 100,
      weekly_end_time: WEEKLY_RESET.getTime(),
      current_weekly_status: 2,
      current_weekly_remaining_percent: 0,
    },
  ],
}

const token2056 = { kind: "rate-limited", status: 429, message: "(2056)" } as const

describe("a held plan reading sets how long a reset-less refusal cools", () => {
  test("a 2056 after a spent weekly reading cools until the weekly reset, provider-reported", () => {
    const store = createHealthStore({ planReadingMaxAgeMs: 30 * 60_000 })
    const reading = httpDriver("minimax")?.quotaRead?.read(spentWeekly, READ_AT) ?? null
    store.applyRateLimit("mm", reading, READ_AT)

    // The reading alone never cools: it is advisory, and a plan with Credits behind it still serves.
    expect(store.stateOf("mm").breaker.status).toBe("active")

    store.recordFailure("mm", token2056, REFUSED_AT)
    const { breaker } = store.stateOf("mm")
    expect(breaker.status).toBe("cooling_down")
    expect(breaker.cooldownUntil).toEqual(WEEKLY_RESET)
    expect(breaker.cooldownSource).toBe("provider-reported")
  })

  test("with no reading held the same refusal keeps its short estimated backoff", () => {
    const store = createHealthStore({ planReadingMaxAgeMs: 30 * 60_000 })
    store.recordFailure("mm", token2056, REFUSED_AT)
    const { breaker } = store.stateOf("mm")
    expect(breaker.cooldownSource).toBe("estimated")
    expect((breaker.cooldownUntil?.getTime() ?? 0) - REFUSED_AT.getTime()).toBeLessThan(400_000)
  })

  test("a limited reading with no reset of its own borrows the held window's reset too", () => {
    const store = createHealthStore({ planReadingMaxAgeMs: 30 * 60_000 })
    store.applyRateLimit(
      "mm",
      httpDriver("minimax")?.quotaRead?.read(spentWeekly, READ_AT) ?? null,
      READ_AT,
    )
    store.applyRateLimit("mm", { limited: true, resetSource: "unknown", windows: [] }, REFUSED_AT)
    expect(store.stateOf("mm").breaker.cooldownUntil).toEqual(WEEKLY_RESET)
  })
})

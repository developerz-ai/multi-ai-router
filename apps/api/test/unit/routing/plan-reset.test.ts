import { describe, expect, test } from "bun:test"
import type { QuotaWindowState } from "@multi-ai-router/core"
import {
  type AttemptFailure,
  DEFAULT_KEY_CAP_NEAR_UTILIZATION,
  HEALTHY,
  keyCapResetFor,
  recordFailure,
  spentPlanReset,
  verifiedKeyCapReset,
  withPlanReset,
} from "../../../src/services/routing"

/**
 * A limit refusal that names no reset borrows the spent plan window's. Prod fingerprint, 2026-11-06:
 * the `minimax` account answered `429 … (2056)` with no reset, cooled five minutes at a time (92
 * consecutive failures, `resetSource: estimated`) while its own usage endpoint said the weekly
 * window reopened at 2026-11-09T00:00Z.
 */

const NOW = new Date("2026-11-06T23:02:36.000Z")
const WEEKLY_RESET = new Date("2026-11-09T00:00:00.000Z")
/** Two 15-minute plan read intervals, as `composition/warm-state.ts` derives it. */
const FRESH = 30 * 60_000
const FIVE_HOUR_RESET = new Date("2026-11-07T00:00:00.000Z")

function window(overrides: Partial<QuotaWindowState> = {}): QuotaWindowState {
  return {
    window: "seven_day",
    utilization: 1,
    utilizationSource: "continuous",
    resetsAt: WEEKLY_RESET,
    resetSource: "provider-reported",
    lastCheckedAt: NOW,
    advisory: true,
    ...overrides,
  }
}

const token2056: AttemptFailure = {
  kind: "rate-limited",
  status: 429,
  message: "Token Plan usage limit reached (2056)",
}

describe("withPlanReset, failure case first", () => {
  test("a reset-less 429 on a spent weekly window cools until the window's own reset", () => {
    const planned = withPlanReset(token2056, [window()], NOW, FRESH)
    expect(planned.resetsAt).toEqual(WEEKLY_RESET)
    expect(planned.resetSource).toBe("provider-reported")
  })

  test("an estimated re-test cadence (Kimi's 403) gives way to the provider's reset", () => {
    const kimi: AttemptFailure = {
      kind: "rate-limited",
      status: 403,
      retryAfterSeconds: 3600,
      resetSource: "estimated",
      message: "You've reached your weekly (7-day) usage limit.",
    }
    const planned = withPlanReset(kimi, [window()], NOW, FRESH)
    expect(planned.resetsAt).toEqual(WEEKLY_RESET)
    expect(planned.retryAfterSeconds).toBeUndefined()
    expect(planned.resetSource).toBe("provider-reported")
  })

  test("with two spent windows the account opens when the later one does", () => {
    const fiveHour = window({ window: "five_hour", resetsAt: FIVE_HOUR_RESET })
    expect(withPlanReset(token2056, [fiveHour, window()], NOW, FRESH).resetsAt).toEqual(
      WEEKLY_RESET,
    )
  })
})

describe("withPlanReset leaves everything else alone", () => {
  test("a reset the refusal stated stands, even a shorter one", () => {
    const zai: AttemptFailure = {
      ...token2056,
      resetsAt: FIVE_HOUR_RESET,
      resetSource: "provider-reported",
    }
    expect(withPlanReset(zai, [window()], NOW, FRESH)).toBe(zai)
  })

  test("a Retry-After the upstream sent stands", () => {
    const stated: AttemptFailure = { ...token2056, retryAfterSeconds: 30 }
    expect(withPlanReset(stated, [window()], NOW, FRESH)).toBe(stated)
  })

  test("only a rate limit borrows: a server error keeps its backoff", () => {
    const fault: AttemptFailure = { kind: "server-error", status: 500, message: "boom" }
    expect(withPlanReset(fault, [window()], NOW, FRESH)).toBe(fault)
  })

  test("a window with headroom, an estimated or unknown reset, or a past reset lends nothing", () => {
    for (const held of [
      window({ utilization: 0.99 }),
      window({ resetSource: "estimated" }),
      window({ resetSource: "unknown", resetsAt: undefined }),
      window({ resetsAt: new Date(NOW.getTime() - 1) }),
      window({ utilization: undefined, utilizationSource: "threshold-triggered" }),
      window({ blocksRouting: false }),
    ]) {
      expect(withPlanReset(token2056, [held], NOW, FRESH)).toBe(token2056)
    }
  })

  test("a stale reading lends nothing: the endpoint may have died or the plan been cancelled", () => {
    const stale = window({ lastCheckedAt: new Date(NOW.getTime() - FRESH - 1) })
    expect(withPlanReset(token2056, [stale], NOW, FRESH)).toBe(token2056)
    expect(withPlanReset(token2056, [window()], NOW, 0)).toBe(token2056)
  })

  test("no windows, no reset", () => {
    expect(spentPlanReset([], NOW, FRESH)).toBeNull()
  })
})

describe("verifiedKeyCapReset, the client path's key-cap evidence", () => {
  const cap = (overrides: Partial<QuotaWindowState> = {}) =>
    window({ window: "spend_limit", ...overrides })

  test("a fresh spent provider-reported cap yields its exact reset", () => {
    expect(verifiedKeyCapReset([cap()], NOW, FRESH)).toEqual(WEEKLY_RESET)
  })

  test("a plan window that is not a key cap lends nothing", () => {
    expect(verifiedKeyCapReset([window()], NOW, FRESH)).toBeNull()
  })

  test("headroom, estimated/unknown reset, past reset and stale reading invent no instant", () => {
    for (const held of [
      cap({ utilization: 0.99 }),
      cap({ resetSource: "estimated" }),
      cap({ resetSource: "unknown", resetsAt: undefined }),
      cap({ resetsAt: new Date(NOW.getTime() - 1) }),
      cap({ utilization: undefined, utilizationSource: "threshold-triggered" }),
      cap({ blocksRouting: false }),
      cap({ lastCheckedAt: new Date(NOW.getTime() - FRESH - 1) }),
    ]) {
      expect(verifiedKeyCapReset([held], NOW, FRESH)).toBeNull()
    }
  })

  test("no windows, no reset", () => {
    expect(verifiedKeyCapReset([], NOW, FRESH)).toBeNull()
  })
})

/**
 * Prod fingerprint, 2026-11-23 (#441): `openrouter-dz-coding-30d` hit its daily key cap at 17:00Z.
 * OpenRouter refuses a request the cap's remainder cannot cover, so the `402` landed while the
 * reading stood under 100 %; the account parked `exhausted` and answered `402 needs a top-up` until
 * 03:03Z, three hours past its own 00:00Z reset.
 *
 * Which refusal that is, is the driver's to say (`openrouter:key-limit-window`: `rate-limited`,
 * estimated re-test). A `402` that names no cap is the prepaid balance, whatever the cap reads.
 * The data-plane proof of both is `test/integration/openrouter-key-cap.test.ts`.
 */
describe("a key cap refuses before its reading says spent", () => {
  const AT = new Date("2026-11-23T17:00:00.000Z")
  const MIDNIGHT = new Date("2026-11-24T00:00:00.000Z")
  const nearCap = (overrides: Partial<QuotaWindowState> = {}) =>
    window({
      window: "spend_limit",
      utilization: 0.97,
      resetsAt: MIDNIGHT,
      lastCheckedAt: new Date(AT.getTime() - 10 * 60_000),
      ...overrides,
    })
  /** What the OpenRouter driver makes of `… create a key with a higher daily limit`. */
  const capNamed: AttemptFailure = {
    kind: "rate-limited",
    status: 402,
    retryAfterSeconds: 3600,
    resetSource: "estimated",
    message: "openrouter:key-limit-window",
    keyCap: true,
  }
  /** `402 Insufficient credits`, or `limit_source: openrouter_credits`: the prepaid balance. */
  const balance: AttemptFailure = {
    kind: "credits-exhausted",
    status: 402,
    message: "openrouter:insufficient-credits",
    namesBalance: true,
  }
  /** A `402` nothing classified: no word about a key, a cap or a balance. */
  const ambiguous: AttemptFailure = {
    kind: "credits-exhausted",
    status: 402,
    message: "upstream returned 402",
  }

  test("a refusal naming the cap, at 97 %, cools until the cap's own reset", () => {
    const planned = withPlanReset(capNamed, [nearCap()], AT, FRESH)
    expect(planned.kind).toBe("rate-limited")
    expect(planned.resetsAt).toEqual(MIDNIGHT)
    expect(planned.retryAfterSeconds).toBeUndefined()
    expect(planned.resetSource).toBe("provider-reported")
    const breaker = recordFailure(HEALTHY, planned, AT)
    expect(breaker.status).toBe("cooling_down")
    expect(breaker.cooldownUntil).toEqual(MIDNIGHT)
  })

  // Review of #504: a key at 97 % of its daily cap can sit on an empty prepaid balance. Lending
  // the cap's reset to that 402 answered `429` until midnight for a wall only a top-up clears.
  test("a 402 naming the balance, on that same key, stays exhausted", () => {
    expect(withPlanReset(balance, [nearCap()], AT, FRESH)).toBe(balance)
    expect(recordFailure(HEALTHY, balance, AT).status).toBe("exhausted")
    // The client path reads the same rule, so it does not say `429` for an exhausted account.
    expect(verifiedKeyCapReset([nearCap()], AT, FRESH)).toBeNull()
  })

  // E's driver flag: the sentence names the key's cap but no window (`Key limit exceeded`,
  // `limit_source: openrouter_key_limit`), so it stays `credits-exhausted` and carries `keyCap`.
  test("a credits refusal flagged as the key's cap borrows the near-spent cap's reset", () => {
    const flagged: AttemptFailure = { ...ambiguous, message: "openrouter:key-limit", keyCap: true }
    const planned = withPlanReset(flagged, [nearCap()], AT, FRESH)
    expect(planned.kind).toBe("rate-limited")
    expect(planned.resetsAt).toEqual(MIDNIGHT)
    // A total cap names no reset: flagged or not, it stays a human's.
    const total = nearCap({ resetsAt: undefined, resetSource: "unknown" })
    expect(withPlanReset(flagged, [total], AT, FRESH)).toBe(flagged)
  })

  test("the client path's predicate is the breaker's, refusal by refusal", () => {
    const flagged: AttemptFailure = { ...ambiguous, keyCap: true }
    const perMinute: AttemptFailure = { kind: "rate-limited", status: 429, message: "slow down" }
    expect(keyCapResetFor(capNamed, [nearCap()], AT, FRESH)).toEqual(MIDNIGHT)
    expect(keyCapResetFor(flagged, [nearCap()], AT, FRESH)).toEqual(MIDNIGHT)
    expect(keyCapResetFor(balance, [nearCap()], AT, FRESH)).toBeNull()
    expect(keyCapResetFor(balance, [nearCap({ utilization: 1 })], AT, FRESH)).toBeNull()
    expect(keyCapResetFor(ambiguous, [nearCap()], AT, FRESH)).toBeNull()
    expect(keyCapResetFor(perMinute, [nearCap({ utilization: 1 })], AT, FRESH)).toBeNull()
  })

  // Review of #506: this asserted that an explicit balance refusal borrows a fully spent cap's
  // reset. No key reset refills a prepaid balance: the account cooled until midnight, answered
  // `429`, and at midnight was refused again.
  test("a refusal naming the balance borrows nothing, even from a fully spent cap", () => {
    const spent = nearCap({ utilization: 1 })
    expect(withPlanReset(balance, [spent], AT, FRESH)).toBe(balance)
    expect(recordFailure(HEALTHY, balance, AT).status).toBe("exhausted")
    expect(keyCapResetFor(balance, [spent], AT, FRESH)).toBeNull()
  })

  test("an ambiguous credits refusal borrows only from a cap the reading says is fully spent", () => {
    const spent = nearCap({ utilization: 1 })
    expect(withPlanReset(ambiguous, [nearCap()], AT, FRESH)).toBe(ambiguous)
    const planned = withPlanReset(ambiguous, [spent], AT, FRESH)
    expect(planned.kind).toBe("rate-limited")
    expect(planned.resetsAt).toEqual(MIDNIGHT)
    expect(keyCapResetFor(ambiguous, [spent], AT, FRESH)).toEqual(MIDNIGHT)
  })

  test("the balance outranks a key-cap flag carried beside it", () => {
    const both: AttemptFailure = { ...balance, keyCap: true }
    expect(withPlanReset(both, [nearCap({ utilization: 1 })], AT, FRESH)).toBe(both)
  })

  test("the near-cap bound is the caller's, and applies to the cap-named refusal alone", () => {
    expect(withPlanReset(capNamed, [nearCap()], AT, FRESH, 1)).toBe(capNamed)
    expect(withPlanReset(capNamed, [nearCap()], AT, FRESH, 0.95).resetsAt).toEqual(MIDNIGHT)
    expect(withPlanReset(balance, [nearCap()], AT, FRESH, 0.5)).toBe(balance)
    expect(DEFAULT_KEY_CAP_NEAR_UTILIZATION).toBeLessThan(1)
  })

  test("a bound outside (0, 1] never lends on an idle cap", () => {
    for (const bound of [0, -1, 2, Number.NaN]) {
      expect(verifiedKeyCapReset([nearCap({ utilization: 0.1 })], AT, FRESH, bound)).toBeNull()
      expect(withPlanReset(capNamed, [nearCap({ utilization: 0.1 })], AT, FRESH, bound)).toBe(
        capNamed,
      )
    }
  })

  test("a cap with real headroom, or a total cap with no reset, lends to neither", () => {
    const total = nearCap({ resetsAt: undefined, resetSource: "unknown" })
    for (const failure of [capNamed, balance]) {
      expect(withPlanReset(failure, [nearCap({ utilization: 0.5 })], AT, FRESH)).toBe(failure)
      expect(withPlanReset(failure, [total], AT, FRESH)).toBe(failure)
    }
  })

  test("a 429 on a near-cap key that the driver did not flag is not the cap", () => {
    const perMinute: AttemptFailure = { kind: "rate-limited", status: 429, message: "slow down" }
    expect(withPlanReset(perMinute, [nearCap()], AT, FRESH)).toBe(perMinute)
    // Nor is another provider's estimated re-test (Kimi's weekly 403): estimated is not the flag.
    const estimated: AttemptFailure = {
      ...perMinute,
      retryAfterSeconds: 3600,
      resetSource: "estimated",
    }
    expect(withPlanReset(estimated, [nearCap()], AT, FRESH)).toBe(estimated)
  })
})

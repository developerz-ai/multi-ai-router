/**
 * The circuit breaker's state machine.
 *
 * The invariant this file exists to protect: **`cooling_down` and `exhausted` are never
 * conflated.** A clock fixes the first; only a human fixes the second, and no amount of clock
 * advance moves it.
 */

import { describe, expect, test } from "bun:test"
import {
  type AttemptFailure,
  type BreakerState,
  backoffMs,
  DEFAULT_FAILURE_THRESHOLD,
  type FailureKind,
  HEALTHY,
  JITTER_FRACTION,
  phase,
  recordFailure,
  recordSuccess,
} from "../../../src/services/routing"
import { at, NOW } from "./fixtures"

const failure = (kind: FailureKind, overrides: Partial<AttemptFailure> = {}): AttemptFailure => ({
  kind,
  message: kind,
  ...overrides,
})

const trip = (state: BreakerState, kind: FailureKind, times: number): BreakerState => {
  let current = state
  for (let index = 0; index < times; index += 1) {
    current = recordFailure(current, failure(kind), NOW)
  }
  return current
}

describe("cooling down — temporary, a clock will fix it", () => {
  test("a 429 trips it immediately, at the provider-reported reset", () => {
    const state = recordFailure(HEALTHY, failure("rate-limited", { resetsAt: at(600_000) }), NOW)

    expect(state.status).toBe("cooling_down")
    expect(state.cooldownUntil).toEqual(at(600_000))
    expect(state.cooldownSource).toBe("provider-reported")
  })

  test("a Retry-After is a reported reset too", () => {
    const state = recordFailure(HEALTHY, failure("rate-limited", { retryAfterSeconds: 90 }), NOW)
    expect(state.cooldownUntil).toEqual(at(90_000))
    expect(state.cooldownSource).toBe("provider-reported")
  })

  test("with nothing reported it falls back to backoff, labeled estimated — not dressed as fact", () => {
    const state = recordFailure(HEALTHY, failure("rate-limited"), NOW)
    // `estimated`, not `unknown`. The instant is real — we computed it from the backoff schedule —
    // and that is exactly what the middle value of `ResetSource` is for. `unknown` is reserved for
    // having no instant at all, which is the `exhausted` case. The console renders this qualifier
    // beside the countdown, so an operator can tell the provider's own reset from our arithmetic.
    expect(state.cooldownSource).toBe("estimated")
    expect(state.cooldownUntil).toEqual(at(backoffMs(1)))
  })

  test("an auth failure carries no reset instant, so its source really is unknown", () => {
    // The contrast that makes the value above meaningful: nothing here computed a time.
    const state = recordFailure(HEALTHY, failure("auth"), NOW, { authKind: "api-key" })
    expect(state.cooldownUntil).toBeUndefined()
    expect(state.cooldownSource).toBe("unknown")
  })

  test("5xx counts toward a streak and trips only at the threshold", () => {
    const almost = trip(HEALTHY, "server-error", DEFAULT_FAILURE_THRESHOLD - 1)
    expect(almost.status).toBe("active")
    expect(almost.consecutiveFailures).toBe(DEFAULT_FAILURE_THRESHOLD - 1)

    const tripped = recordFailure(almost, failure("server-error"), NOW)
    expect(tripped.status).toBe("cooling_down")
  })

  test("connection failures and timeouts feed the same streak", () => {
    expect(trip(HEALTHY, "connection", DEFAULT_FAILURE_THRESHOLD).status).toBe("cooling_down")
    expect(trip(HEALTHY, "timeout", DEFAULT_FAILURE_THRESHOLD).status).toBe("cooling_down")
  })

  test("a later mark extends the cooldown; an earlier one never shortens it", () => {
    const long = recordFailure(HEALTHY, failure("rate-limited", { resetsAt: at(600_000) }), NOW)
    const short = recordFailure(long, failure("rate-limited", { resetsAt: at(60_000) }), NOW)
    expect(short.cooldownUntil).toEqual(at(600_000))

    const longer = recordFailure(short, failure("rate-limited", { resetsAt: at(900_000) }), NOW)
    expect(longer.cooldownUntil).toEqual(at(900_000))
  })

  test("the reset instant passing opens a half-open probe", () => {
    const state = recordFailure(HEALTHY, failure("rate-limited", { resetsAt: at(60_000) }), NOW)

    expect(phase(state, NOW)).toBe("open")
    expect(phase(state, at(59_999))).toBe("open")
    expect(phase(state, at(60_000))).toBe("half-open")
    expect(phase(state, at(600_000))).toBe("half-open")
  })

  test("a probe that succeeds returns the account to active and resets the streak", () => {
    const state = recordFailure(HEALTHY, failure("rate-limited", { resetsAt: at(60_000) }), NOW)
    const recovered = recordSuccess()

    expect(phase(state, at(60_000))).toBe("half-open")
    expect(recovered).toEqual(HEALTHY)
    expect(phase(recovered, NOW)).toBe("closed")
  })

  test("a probe that fails cools down again at the next backoff step", () => {
    const first = recordFailure(HEALTHY, failure("server-error"), NOW)
    const second = recordFailure(first, failure("server-error"), NOW)
    const third = recordFailure(second, failure("server-error"), NOW)
    const fourth = recordFailure(third, failure("server-error"), at(backoffMs(3)))

    expect(fourth.consecutiveFailures).toBe(4)
    expect(fourth.cooldownUntil?.getTime()).toBeGreaterThan(third.cooldownUntil?.getTime() ?? 0)
  })
})

describe("exhausted — permanent until a human acts", () => {
  const exhausted = recordFailure(HEALTHY, failure("credits-exhausted"), NOW)

  test("a 402 is exhausted, never cooling down", () => {
    expect(exhausted.status).toBe("exhausted")
  })

  test("it carries no reset — that absence is what distinguishes it", () => {
    expect(exhausted.cooldownUntil).toBeUndefined()
  })

  test("no amount of clock advance recovers it", () => {
    for (const offset of [0, 1_000, 60_000, 86_400_000, 365 * 86_400_000]) {
      expect(phase(exhausted, at(offset))).toBe("blocked")
    }
  })

  test("a cooling account that then reports out-of-credits becomes exhausted and loses its timer", () => {
    const cooling = recordFailure(HEALTHY, failure("rate-limited", { resetsAt: at(600_000) }), NOW)
    const dead = recordFailure(cooling, failure("credits-exhausted"), NOW)

    expect(dead.status).toBe("exhausted")
    expect(dead.cooldownUntil).toBeUndefined()
    expect(phase(dead, at(3_600_000))).toBe("blocked")
  })

  test("only a successful probe — which a human has to trigger — returns it to active", () => {
    expect(recordSuccess().status).toBe("active")
  })
})

describe("auth failures are not cooldowns", () => {
  test("an OAuth account needs re-auth", () => {
    const state = recordFailure(HEALTHY, failure("auth"), NOW, { authKind: "oauth" })
    expect(state.status).toBe("needs_reauth")
    expect(state.cooldownUntil).toBeUndefined()
    expect(phase(state, at(86_400_000))).toBe("blocked")
  })

  test("an API-key account is disabled", () => {
    const state = recordFailure(HEALTHY, failure("auth"), NOW, { authKind: "api-key" })
    expect(state.status).toBe("disabled")
  })

  test("a no-auth account is disabled too: there is nothing to re-authorize", () => {
    // A local endpoint that suddenly rejects an anonymous request has grown something in front of
    // it. `needs_reauth` would offer the operator a login this account has never had.
    const state = recordFailure(HEALTHY, failure("auth"), NOW, { authKind: "none" })
    expect(state.status).toBe("disabled")
    expect(phase(state, at(86_400_000))).toBe("blocked")
  })
})

describe("failures that say nothing about the account", () => {
  test.each(["client-error", "stale-session"] as const)("%s leaves the state untouched", (kind) => {
    const streaked = trip(HEALTHY, "server-error", 1)
    expect(recordFailure(streaked, failure(kind), NOW)).toEqual(streaked)
  })
})

describe("backoff", () => {
  test("doubles per consecutive failure and caps", () => {
    expect(backoffMs(1, { baseBackoffMs: 1_000, maxBackoffMs: 10_000 })).toBe(1_000)
    expect(backoffMs(2, { baseBackoffMs: 1_000, maxBackoffMs: 10_000 })).toBe(2_000)
    expect(backoffMs(3, { baseBackoffMs: 1_000, maxBackoffMs: 10_000 })).toBe(4_000)
    expect(backoffMs(9, { baseBackoffMs: 1_000, maxBackoffMs: 10_000 })).toBe(10_000)
  })

  test("jitter is a caller-supplied fraction, so the math stays deterministic", () => {
    expect(backoffMs(1, { baseBackoffMs: 1_000, jitter: 0 })).toBe(1_000)
    expect(backoffMs(1, { baseBackoffMs: 1_000, jitter: 1 })).toBe(1_000 * (1 + JITTER_FRACTION))
  })

  test("jitter only ever widens a step", () => {
    for (const jitter of [0, 0.25, 0.5, 0.75, 0.99]) {
      expect(backoffMs(2, { baseBackoffMs: 1_000, jitter })).toBeGreaterThanOrEqual(2_000)
    }
  })

  test("a nonsense jitter is ignored rather than propagated", () => {
    expect(backoffMs(1, { baseBackoffMs: 1_000, jitter: Number.NaN })).toBe(1_000)
    expect(backoffMs(1, { baseBackoffMs: 1_000, jitter: -5 })).toBe(1_000)
  })
})

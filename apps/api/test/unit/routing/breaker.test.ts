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
  type BreakerOptions,
  type BreakerState,
  backoffMs,
  DEFAULT_AUTH_FAILURE_MAX_COOLDOWN_MS,
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
    // The contrast that makes the value above meaningful: nothing here computed a time. OAuth, since
    // a rejected API key now does compute one — its re-test cooldown.
    const state = recordFailure(HEALTHY, failure("auth"), NOW, { authKind: "oauth" })
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

describe("auth failures never pose as the operator's switch", () => {
  test("an OAuth account needs re-auth", () => {
    const state = recordFailure(HEALTHY, failure("auth"), NOW, { authKind: "oauth" })
    expect(state.status).toBe("needs_reauth")
    expect(state.cooldownUntil).toBeUndefined()
    expect(phase(state, at(86_400_000))).toBe("blocked")
  })

  test("an API-key account is a credential-rejected cooldown, not `disabled`", () => {
    const state = recordFailure(HEALTHY, failure("auth"), NOW, { authKind: "api-key" })
    expect(state.status).toBe("cooling_down")
    expect(state.cooldownReason).toBe("credential-rejected")
  })

  test("a no-auth account is the same cooldown: there is nothing to re-authorize", () => {
    // A local endpoint that suddenly rejects an anonymous request has grown something in front of
    // it. `needs_reauth` would offer the operator a login this account has never had.
    const state = recordFailure(HEALTHY, failure("auth"), NOW, { authKind: "none" })
    expect(state.status).toBe("cooling_down")
    expect(state.cooldownReason).toBe("credential-rejected")
    expect(phase(state, at(86_400_000))).toBe("half-open")
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

/**
 * 2026-10-02: a Kimi key answered one `403` at 02:18Z and the breaker parked the account at
 * `disabled` — the operator's own word for "switched off" — in memory only, with no reset and no
 * probe, while the stored row still said `active`. It took a human to notice. A rejected key still
 * needs a human; what it must not be is a state no clock ever re-tests, wearing the operator's label.
 */
describe("a rejected API key is a long, labeled cooldown — never the operator's `disabled`", () => {
  const COOLDOWN = 900_000

  test.each([["api-key"], ["none"]] as const)(
    "%s: cooling_down, labeled credential-rejected",
    (authKind) => {
      const state = recordFailure(HEALTHY, failure("auth", { status: 403 }), NOW, {
        authKind,
        authFailureCooldownMs: COOLDOWN,
      })

      expect(state.status).toBe("cooling_down")
      expect(state.status).not.toBe("disabled")
      expect(state.cooldownReason).toBe("credential-rejected")
      expect(state.cooldownUntil).toEqual(at(COOLDOWN))
      // Our own number, not the provider's: Kimi named no instant.
      expect(state.cooldownSource).toBe("estimated")
      expect(state.consecutiveFailures).toBe(1)
    },
  )

  test("it is re-tested on a clock: open until the cooldown passes, then one half-open probe", () => {
    const state = recordFailure(HEALTHY, failure("auth"), NOW, {
      authKind: "api-key",
      authFailureCooldownMs: COOLDOWN,
    })

    expect(phase(state, at(COOLDOWN - 1))).toBe("open")
    expect(phase(state, at(COOLDOWN))).toBe("half-open")
  })

  test("the cooldown defaults to fifteen minutes when nothing configures it", () => {
    const state = recordFailure(HEALTHY, failure("auth"), NOW, { authKind: "api-key" })
    expect(state.cooldownUntil).toEqual(at(15 * 60_000))
  })

  test("a probe that is rate-limited proved the key works: the label goes", () => {
    const rejected = recordFailure(HEALTHY, failure("auth"), NOW, {
      authKind: "api-key",
      authFailureCooldownMs: COOLDOWN,
    })
    const probed = recordFailure(
      rejected,
      failure("rate-limited", { retryAfterSeconds: 60 }),
      at(COOLDOWN),
    )

    expect(probed.status).toBe("cooling_down")
    expect(probed.cooldownReason).toBeUndefined()
  })

  test("a probe that succeeds returns the account to active, with no label", () => {
    const rejected = recordFailure(HEALTHY, failure("auth"), NOW, { authKind: "api-key" })
    expect(rejected.cooldownReason).toBe("credential-rejected")
    expect(recordSuccess()).toEqual(HEALTHY)
  })

  test("a shorter reading riding the same response never shortens it, and keeps the label", () => {
    const rejected = recordFailure(HEALTHY, failure("auth"), NOW, {
      authKind: "api-key",
      authFailureCooldownMs: COOLDOWN,
    })
    const withHeader = recordFailure(
      rejected,
      failure("rate-limited", { retryAfterSeconds: 60 }),
      NOW,
    )

    expect(withHeader.cooldownUntil).toEqual(at(COOLDOWN))
    expect(withHeader.cooldownReason).toBe("credential-rejected")
  })

  test("OAuth is unchanged: a refreshable login really does need one", () => {
    const state = recordFailure(HEALTHY, failure("auth"), NOW, {
      authKind: "oauth",
      authFailureCooldownMs: COOLDOWN,
    })
    expect(state.status).toBe("needs_reauth")
    expect(state.cooldownReason).toBeUndefined()
    expect(phase(state, at(86_400_000))).toBe("blocked")
  })
})

/**
 * Review of #139: a key the provider genuinely revoked was re-tested every 15 minutes forever — the
 * same cadence on the hundredth refusal as on the first, and the same instant for every key refused
 * together. The cooldown now doubles per consecutive refusal up to a configured cap, jitter widens
 * each step, and a success starts the count over.
 */
describe("a key that stays refused is re-tested less and less often", () => {
  const BASE = 900_000
  const HOUR = 3_600_000
  const reject = (state: BreakerState, now: Date, options: BreakerOptions = {}): BreakerState =>
    recordFailure(state, failure("auth"), now, {
      authKind: "api-key",
      authFailureCooldownMs: BASE,
      ...options,
    })
  /** Refuse `times` times in a row, each refusal at the instant the previous cooldown ended. */
  const refuse = (times: number, options: BreakerOptions = {}): BreakerState => {
    let state = HEALTHY
    let now = NOW
    for (let index = 0; index < times; index += 1) {
      state = reject(state, now, options)
      now = state.cooldownUntil ?? now
    }
    return state
  }
  const step = (state: BreakerState, from: Date): number =>
    (state.cooldownUntil?.getTime() ?? 0) - from.getTime()

  test("each refusal doubles the cooldown: 15, 30, 60 minutes", () => {
    const first = reject(HEALTHY, NOW)
    expect(step(first, NOW)).toBe(BASE)
    expect(first.consecutiveFailures).toBe(1)

    const secondAt = first.cooldownUntil ?? NOW
    const second = reject(first, secondAt)
    expect(step(second, secondAt)).toBe(2 * BASE)
    expect(second.consecutiveFailures).toBe(2)

    const thirdAt = second.cooldownUntil ?? NOW
    const third = reject(second, thirdAt)
    expect(step(third, thirdAt)).toBe(4 * BASE)
    expect(third.cooldownReason).toBe("credential-rejected")
  })

  /**
   * Review of #139, round 2: the streak counted every refused *response*, and one incident produces
   * several — each request already in flight when the first refusal landed comes back refused too.
   * Five at once put a key on a four-hour cooldown the first time it was ever refused. Only a
   * re-test moves the streak; a refusal landing inside the labeled cooldown is the same refusal.
   */
  test("refusals already in flight when the first one landed are one refusal, not a streak", () => {
    let state = HEALTHY
    for (let index = 0; index < 5; index += 1) state = reject(state, NOW)

    expect(step(state, NOW)).toBe(BASE)
    expect(state.consecutiveFailures).toBe(1)
    expect(state.cooldownReason).toBe("credential-rejected")
    expect(state.cooldownSource).toBe("estimated")

    // A straggler answering minutes later, with its own jitter: still inside the cooldown, so it
    // moves neither the count nor the instant the first refusal set.
    expect(reject(state, at(BASE - 1), { jitter: 1 })).toEqual(state)
  })

  test("the probe is the re-test: refused once the cooldown has passed, it doubles", () => {
    let state = HEALTHY
    for (let index = 0; index < 5; index += 1) state = reject(state, NOW)

    const probeAt = state.cooldownUntil ?? NOW
    const probed = reject(state, probeAt)
    expect(step(probed, probeAt)).toBe(2 * BASE)
    expect(probed.consecutiveFailures).toBe(2)

    // And the requests racing that probe's refusal are, again, the same refusal.
    expect(reject(probed, probeAt)).toEqual(probed)
  })

  test("a refusal during an ordinary cooldown still labels it: only a labeled one absorbs", () => {
    const limited = recordFailure(HEALTHY, failure("rate-limited", { retryAfterSeconds: 60 }), NOW)
    expect(limited.cooldownReason).toBeUndefined()

    const refused = reject(limited, NOW)
    expect(refused.cooldownReason).toBe("credential-rejected")
    expect(step(refused, NOW)).toBe(BASE)
    expect(refused.consecutiveFailures).toBe(1)
  })

  test("the growth stops at the configured cap", () => {
    const capped = refuse(10, { authFailureMaxCooldownMs: HOUR })
    const lastAt = new Date((capped.cooldownUntil?.getTime() ?? 0) - HOUR)
    expect(step(capped, lastAt)).toBe(HOUR)
  })

  test("a cap set below the cooldown is read as the cooldown: the first step is never the longest", () => {
    const first = reject(HEALTHY, NOW, { authFailureMaxCooldownMs: 60_000 })
    expect(step(first, NOW)).toBe(BASE)
    const secondAt = first.cooldownUntil ?? NOW
    expect(step(reject(first, secondAt, { authFailureMaxCooldownMs: 60_000 }), secondAt)).toBe(BASE)
  })

  test("with nothing configured the cap is four hours", () => {
    expect(DEFAULT_AUTH_FAILURE_MAX_COOLDOWN_MS).toBe(4 * HOUR)
    const capped = refuse(12)
    const lastAt = new Date((capped.cooldownUntil?.getTime() ?? 0) - 4 * HOUR)
    expect(step(capped, lastAt)).toBe(4 * HOUR)
  })

  test("jitter widens a step by at most JITTER_FRACTION and never shortens it — at the cap too", () => {
    const jittered = reject(HEALTHY, NOW, { jitter: 1 })
    expect(step(jittered, NOW)).toBe(Math.round(BASE * (1 + JITTER_FRACTION)))

    let state = HEALTHY
    let now = NOW
    for (let index = 0; index < 10; index += 1) {
      state = reject(state, now, { authFailureMaxCooldownMs: HOUR, jitter: 1 })
      if (index < 9) now = state.cooldownUntil ?? now
    }
    expect(step(state, now)).toBe(Math.round(HOUR * (1 + JITTER_FRACTION)))
  })

  test("a success starts the count over", () => {
    const refused = refuse(3)
    expect(refused.consecutiveFailures).toBe(3)

    const recovered = recordSuccess()
    const again = reject(recovered, NOW)
    expect(step(again, NOW)).toBe(BASE)
    expect(again.consecutiveFailures).toBe(1)
  })

  test("once labeled, a server error on the probe keeps the label and counts toward the streak", () => {
    // Pinned as it behaves, not as an ideal: a 5xx below the failure threshold leaves the labeled
    // cooldown in place, so the next refusal steps past it. Bounded by the cap either way.
    const refused = reject(HEALTHY, NOW)
    const probeAt = refused.cooldownUntil ?? NOW
    const flaky = recordFailure(refused, failure("server-error"), probeAt)
    expect(flaky.cooldownReason).toBe("credential-rejected")
    expect(flaky.consecutiveFailures).toBe(2)

    const again = reject(flaky, probeAt)
    expect(step(again, probeAt)).toBe(4 * BASE)
    expect(again.consecutiveFailures).toBe(3)
  })

  test("a streak of server errors before it does not inflate the first refusal", () => {
    const flaky = recordFailure(
      recordFailure(HEALTHY, failure("server-error"), NOW),
      failure("server-error"),
      NOW,
    )
    expect(flaky.consecutiveFailures).toBe(2)

    const refused = reject(flaky, NOW)
    expect(step(refused, NOW)).toBe(BASE)
    expect(refused.consecutiveFailures).toBe(1)
  })
})

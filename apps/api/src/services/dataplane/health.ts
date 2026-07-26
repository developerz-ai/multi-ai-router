import type { AuthKind } from "@multi-ai-router/core"
import type { RateLimitSignal, RateLimitWindow } from "../../providers"
import {
  type AttemptFailure,
  type BreakerOptions,
  type BreakerState,
  HEALTHY,
  phase,
  recordFailure,
  recordSuccess,
} from "../routing"

/**
 * The in-memory health state the pure selection functions read, through `snapshot.ts`.
 *
 * Every signal folds in here and nowhere else: rate-limit headers parsed off each response,
 * consecutive failure streaks, auth failures, and out-of-credits classifications
 * (docs/idea/05-routing-and-failover.md#health-signals-feeding-it). Routing then reads one
 * immutable snapshot and reads nothing else — no clock, no store, no lock.
 *
 * **Breaker state is routing hygiene, not durable truth.** After a restart the first failing
 * request re-marks. That is the design, not a gap.
 *
 * `cooling_down` and `exhausted` stay separate all the way down, mechanically: `exhausted` carries
 * no cooldown instant, so no amount of clock advance moves it and nothing here schedules a retry.
 *
 * This is also where the breaker's numbers are *supplied*. `breaker.ts` reads no configuration and
 * no randomness of its own, so the operator's thresholds and a fresh jitter fraction are merged in
 * here, on every transition the store makes — including the one `applyRateLimit` folds in, which
 * would otherwise silently use the module defaults.
 */

export interface AccountHealthState {
  readonly breaker: BreakerState
  /** In-flight requests — the `least-used` measure. */
  readonly inFlight: number
  readonly recentTokens: number
  /**
   * The limiter windows the last upstream response reported. Kept as the provider worded them:
   * HTTP limiter names (`requests`, `input-tokens`) have no `QuotaWindowKind` equivalent, and
   * inventing one would record a fact the provider never stated.
   */
  readonly limiterWindows: readonly RateLimitWindow[]
  readonly lastSignalAt: Date | null
  /**
   * Deadline of the one half-open probe testing this account, or null when none is. Set by
   * {@link HealthStore.admitProbe}, cleared by {@link HealthStore.releaseProbe}, and read by the
   * pure filter through {@link overlayHealth} — which is how "one request through as a probe"
   * becomes something a stateless selection can enforce.
   */
  readonly probeHeldUntil: Date | null
}

const FRESH: AccountHealthState = {
  breaker: HEALTHY,
  inFlight: 0,
  recentTokens: 0,
  limiterWindows: [],
  lastSignalAt: null,
  probeHeldUntil: null,
}

/**
 * How long an admitted probe holds a recovering account when nothing releases it.
 *
 * A backstop, not a schedule: the chain releases the hold the moment its attempt reaches a verdict,
 * so this only matters when a process dies between admitting and releasing. Long enough that a real
 * request reaches an upstream verdict, short enough that a lost probe cannot park a healthy account
 * out of rotation for a coffee break.
 */
export const DEFAULT_PROBE_HOLD_MS = 30_000

/**
 * The breaker's configured shape, supplied once for every transition this store makes.
 *
 * The alternative — every call site passing the numbers — is how `ROUTING_FAILURE_THRESHOLD`,
 * `ROUTING_BASE_BACKOFF_MS`, and `ROUTING_MAX_BACKOFF_MS` came to be parsed at boot and read by
 * nothing: one caller passed `{ authKind }`, another passed nothing at all, and the module defaults
 * quietly won both times.
 */
export interface HealthStoreOptions {
  /** Consecutive 5xx / connection failures before the breaker trips. */
  readonly failureThreshold?: number
  /** First backoff step. Doubles per consecutive failure. */
  readonly baseBackoffMs?: number
  readonly maxBackoffMs?: number
  /**
   * A fresh jitter fraction in `[0, 1]` per transition, defaulting to `Math.random`. Injected
   * because `breaker.ts` deliberately reads no randomness, and because a test that cannot pin the
   * fraction cannot assert a backoff. Without it every account tripped in the same second comes
   * back in the same millisecond and stampedes the provider that just rate-limited them.
   *
   * It moves only the *estimated* schedule: a provider-reported reset is the truth and is never
   * nudged off the instant the provider named.
   */
  readonly jitter?: () => number
  /** {@link DEFAULT_PROBE_HOLD_MS}. */
  readonly probeHoldMs?: number
}

/** Whether this caller may probe, and whether it took the hold it therefore has to release. */
export interface ProbeAdmission {
  readonly admitted: boolean
  /** True only when a hold was taken. A caller that took none must not release another's. */
  readonly held: boolean
}

const ADMITTED_WITHOUT_HOLD: ProbeAdmission = { admitted: true, held: false }
const REFUSED: ProbeAdmission = { admitted: false, held: false }

export interface HealthStore {
  stateOf(accountId: string): AccountHealthState
  /** Marks an attempt started, so `least-used` sees load rather than history. */
  beginAttempt(accountId: string): void
  /** Marks it finished, folding the tokens it spent into the recent-spend measure. */
  endAttempt(accountId: string, tokens?: number): void
  recordSuccess(accountId: string): void
  recordFailure(
    accountId: string,
    failure: AttemptFailure,
    now: Date,
    options?: BreakerOptions,
  ): void
  /**
   * Folds one response's rate-limit reading in. A reported limit cools the account down — unless
   * the account already holds a verdict no clock undoes, which this never overwrites.
   */
  applyRateLimit(accountId: string, signal: RateLimitSignal | null, now: Date): void
  /**
   * Admits **one** half-open probe onto a recovering account, or refuses.
   *
   * The breaker says a `cooling_down` account whose reset has passed gets one request through as a
   * probe. Nothing enforced that: the reset instant passing made the account eligible to *every*
   * request at once, so a thousand callers queued behind a 5-minute cooldown all dispatched onto it
   * in the same millisecond — which is how a provider that rate-limited an account gets a thousand
   * requests the instant it stops. This is the compare-and-swap that makes "one" true.
   *
   * A refusal is not a queue and not a failure: the caller drops the candidate and walks on, and
   * every request whose snapshot was built *after* the hold was taken never sees the account as a
   * candidate at all — the filter drops it as `probe-in-flight`, a `429` with the hold's expiry.
   *
   * Admitted with `held: false` means there was nothing to gate, because the account is `active`
   * again: another request's probe already succeeded and this one is holding a stale label.
   */
  admitProbe(accountId: string, now: Date): ProbeAdmission
  /** Releases the hold, whatever the probe's verdict was. Only the caller that took it may call. */
  releaseProbe(accountId: string): void
  /**
   * Drops every mark for an account — the operator's "Re-check now", and account deletion.
   *
   * The probe hold goes with them, deliberately: `recheck` clears the breaker precisely so the
   * account becomes a half-open probe again, and leaving a stale hold behind would make the button
   * wait out a probe nobody is running.
   */
  reset(accountId: string): void
  entries(): ReadonlyMap<string, AccountHealthState>
}

export function createHealthStore(options: HealthStoreOptions = {}): HealthStore {
  const states = new Map<string, AccountHealthState>()
  const jitter = options.jitter ?? Math.random
  const probeHoldMs = options.probeHoldMs ?? DEFAULT_PROBE_HOLD_MS

  const configured: BreakerOptions = {
    ...(options.failureThreshold === undefined
      ? {}
      : { failureThreshold: options.failureThreshold }),
    ...(options.baseBackoffMs === undefined ? {} : { baseBackoffMs: options.baseBackoffMs }),
    ...(options.maxBackoffMs === undefined ? {} : { maxBackoffMs: options.maxBackoffMs }),
  }

  /**
   * The configured breaker plus one fresh jitter fraction. A caller's own options win, because the
   * only thing a caller knows that this store does not is `authKind` — a fact about the attempt.
   */
  const breakerOptions = (caller?: BreakerOptions): BreakerOptions => ({
    ...configured,
    jitter: jitter(),
    ...caller,
  })

  const read = (accountId: string): AccountHealthState => states.get(accountId) ?? FRESH
  const write = (accountId: string, patch: Partial<AccountHealthState>): void => {
    states.set(accountId, { ...read(accountId), ...patch })
  }

  return {
    stateOf: read,

    beginAttempt(accountId) {
      write(accountId, { inFlight: read(accountId).inFlight + 1 })
    },

    endAttempt(accountId, tokens = 0) {
      const current = read(accountId)
      write(accountId, {
        inFlight: Math.max(0, current.inFlight - 1),
        recentTokens: current.recentTokens + tokens,
      })
    },

    recordSuccess(accountId) {
      write(accountId, { breaker: recordSuccess() })
    },

    recordFailure(accountId, failure, now, options) {
      write(accountId, {
        breaker: recordFailure(read(accountId).breaker, failure, now, breakerOptions(options)),
      })
    },

    applyRateLimit(accountId, signal, now) {
      if (signal === null) return
      const before = read(accountId).breaker
      // The reading itself is a fact and is kept either way — the console renders these windows,
      // and an operator inspecting a dead account still deserves to see what its limiter said.
      write(accountId, { limiterWindows: signal.windows, lastSignalAt: now })
      if (!signal.limited) return

      // A terminal verdict outranks a header. `exhausted` and `needs_reauth` mean a human must act;
      // a cooldown means a clock will fix it, and the two are never conflated (CLAUDE.md
      // non-negotiable 7). Providers routinely ship `x-ratelimit-remaining-*: 0` *alongside* the
      // `402` that drained the balance — this is a header riding a response, not a verdict about
      // it — so folding it in would rewrite "top this account up" as "retry at 14:32", put a dead
      // balance back in the rotation on a timer, and answer the client `429 + Retry-After` for it.
      // `blocked` is the breaker's own name for "no timer will change this", so the two definitions
      // cannot drift apart.
      if (phase(before, now) === "blocked") return

      // A limited signal on an otherwise fine response is still the account saying "not now".
      // Routing it through the breaker's own transition keeps one implementation of the
      // never-shorten rule and of provider-reported-reset preference — and, since the options are
      // the store's, one set of configured numbers rather than the module defaults this call site
      // used to fall back to silently.
      write(accountId, {
        breaker: recordFailure(
          before,
          {
            kind: "rate-limited",
            resetsAt: signal.resetsAt,
            retryAfterSeconds: signal.retryAfterSeconds,
            resetSource: signal.resetSource,
            message: "upstream reported the limit was reached",
          },
          now,
          breakerOptions(),
        ),
      })
    },

    admitProbe(accountId, now) {
      const state = read(accountId)
      // The breaker's own name for "recovering", so who may probe cannot drift from who is
      // recovering. `closed` means another probe already brought the account back and this caller is
      // carrying a stale label: there is nothing left to gate, and refusing a healthy account would
      // drop it from the chain for no reason. `open` and `blocked` are the reverse — the label is
      // stale the other way and the account is genuinely unavailable now.
      const live = phase(state.breaker, now)
      if (live === "closed") return ADMITTED_WITHOUT_HOLD
      if (live !== "half-open") return REFUSED

      const held = state.probeHeldUntil
      if (held !== null && held.getTime() > now.getTime()) return REFUSED

      write(accountId, { probeHeldUntil: new Date(now.getTime() + probeHoldMs) })
      return { admitted: true, held: true }
    },

    releaseProbe(accountId) {
      if (states.has(accountId)) write(accountId, { probeHeldUntil: null })
    },

    reset(accountId) {
      states.delete(accountId)
    },

    entries: () => states,
  }
}

/** Where an auth failure lands: `api-key` -> `disabled`, `oauth` -> `needs_reauth`. */
export function breakerOptionsFor(authKind: AuthKind): BreakerOptions {
  return { authKind }
}

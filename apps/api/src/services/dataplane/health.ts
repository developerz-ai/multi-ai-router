import type { AuthKind } from "@multi-ai-router/core"
import type { RateLimitSignal, RateLimitWindow } from "../../providers"
import type { AccountSnapshot, RoutingSnapshot } from "../routing"
import {
  type AttemptFailure,
  type BreakerOptions,
  type BreakerState,
  HEALTHY,
  recordFailure,
  recordSuccess,
} from "../routing"
import type { RoutingCatalog } from "./types"

/**
 * The in-memory health snapshot the pure selection functions read.
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
}

const FRESH: AccountHealthState = {
  breaker: HEALTHY,
  inFlight: 0,
  recentTokens: 0,
  limiterWindows: [],
  lastSignalAt: null,
}

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
  /** Folds one response's rate-limit reading in. A reported limit cools the account down. */
  applyRateLimit(accountId: string, signal: RateLimitSignal | null, now: Date): void
  /** Drops every mark for an account — the operator's "Re-check now", and account deletion. */
  reset(accountId: string): void
  entries(): ReadonlyMap<string, AccountHealthState>
}

export function createHealthStore(): HealthStore {
  const states = new Map<string, AccountHealthState>()

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
      write(accountId, { breaker: recordFailure(read(accountId).breaker, failure, now, options) })
    },

    applyRateLimit(accountId, signal, now) {
      if (signal === null) return
      write(accountId, { limiterWindows: signal.windows, lastSignalAt: now })
      if (!signal.limited) return

      // A limited signal on an otherwise fine response is still the account saying "not now".
      // Routing it through the breaker's own transition keeps one implementation of the
      // never-shorten rule and of provider-reported-reset preference.
      write(accountId, {
        breaker: recordFailure(
          read(accountId).breaker,
          {
            kind: "rate-limited",
            resetsAt: signal.resetsAt,
            retryAfterSeconds: signal.retryAfterSeconds,
            resetSource: signal.resetSource,
            message: "upstream reported the limit was reached",
          },
          now,
        ),
      })
    },

    reset(accountId) {
      states.delete(accountId)
    },

    entries: () => states,
  }
}

/**
 * The account's routing view with live health overlaid.
 *
 * The stored status is the operator's word (`disabled`, `needs_reauth` after a failed reauth); the
 * breaker's is the router's. The breaker wins whenever it has something to say, because it is the
 * fresher of the two — but it never promotes an account the operator disabled.
 */
export function overlayHealth(
  account: AccountSnapshot,
  state: AccountHealthState,
): AccountSnapshot {
  const configuredBlocks = account.status === "disabled" || account.status === "needs_reauth"
  const status =
    configuredBlocks || state.breaker.status === "active" ? account.status : state.breaker.status

  return {
    ...account,
    status,
    health: {
      cooldownUntil: state.breaker.cooldownUntil,
      cooldownSource: state.breaker.cooldownSource,
      consecutiveFailures: state.breaker.consecutiveFailures,
      inFlight: state.inFlight,
      recentTokens: state.recentTokens,
    },
  }
}

/** The one snapshot a request's selection reads. Built from warm memory; no I/O, no query. */
export function buildSnapshot(
  catalog: RoutingCatalog,
  health: HealthStore,
  now: Date,
): RoutingSnapshot {
  return {
    accounts: catalog
      .accounts()
      .map((account) => overlayHealth(account.snapshot, health.stateOf(account.id))),
    pools: catalog.pools(),
    now,
  }
}

/** Where an auth failure lands: `api-key` -> `disabled`, `oauth` -> `needs_reauth`. */
export function breakerOptionsFor(authKind: AuthKind): BreakerOptions {
  return { authKind }
}

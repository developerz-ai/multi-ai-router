/**
 * The inputs of routing selection.
 *
 * Everything the chain reads arrives here: the clock, account health, pool membership, and the
 * presenting key's scope. No module under `services/routing/` reads a clock, a store, or a
 * socket — `docs/idea/05-routing-and-failover.md` ("Testability") makes that a hard requirement,
 * because selection sits in the hot path of every request.
 */

import type {
  AccountStatus,
  KeyScope,
  ProviderId,
  QuotaWindowState,
  ResetSource,
  RoutingPolicy,
  UtilizationSource,
} from "@multi-ai-router/core"

/**
 * One limiter's headroom, under the provider's own name for it.
 *
 * Separate from {@link AccountSnapshot.quotaWindows} because the vocabularies are separate: an
 * HTTP provider meters `requests` and `input-tokens`, which have no `QuotaWindowKind` equivalent,
 * and minting one would record a fact the provider never stated. What these readings *can* answer
 * is "how much headroom is left", every response, all window long — which is the one question
 * `quota-aware` asks and the reason this is carried at all rather than dropped as unrenderable.
 */
export interface LimiterReading {
  /** `requests`, `input-tokens`, `tokens` — the provider's word, kept verbatim. */
  readonly limiter: string
  /** Fraction consumed, 0..1. Absent when the provider reported no headroom. */
  readonly utilization?: number
  /** Ranking reads `continuous` only: an alarm that fires near the limit ranks nothing. */
  readonly utilizationSource: UtilizationSource
}

/** In-memory health for one account. Kept warm by upstream responses, never queried per request. */
export interface AccountHealth {
  /** Breaker cooldown expiry. Absent when the account is not cooling down. */
  readonly cooldownUntil?: Date
  /**
   * How trustworthy {@link cooldownUntil} is. Carried everywhere the instant is, because a
   * guessed reset presented as fact is worse than no reset at all.
   */
  readonly cooldownSource?: ResetSource
  /** Consecutive upstream failures — the exponential backoff step. */
  readonly consecutiveFailures: number
  /**
   * Deadline of the one half-open probe currently testing this account, absent when none is.
   *
   * The breaker says a recovering account may take **one** request as a probe; this is how that
   * "one" is visible to a pure filter. While it is set and ahead of the clock the account is
   * somebody else's to test, so every other request is dropped as `probe-in-flight` — which is
   * clock-recoverable and therefore a `429` with this instant, never a stampede onto an account
   * that just came back.
   */
  readonly probeHeldUntil?: Date
  /** Requests currently in flight. The default `least-used` measure. */
  readonly inFlight: number
  /** Tokens spent in the recent rolling window. The alternative `least-used` measure. */
  readonly recentTokens: number
}

export interface AccountSnapshot {
  readonly id: string
  readonly label: string
  readonly provider: ProviderId
  readonly status: AccountStatus
  /** Account-level bias for `weighted`; a pool membership may override it. */
  readonly weight: number
  /** Account-level order for `priority-failover`, lower first; a membership may override it. */
  readonly priority: number
  /**
   * The models this account accepts, after alias mapping. Absent or empty means it supports
   * everything: unknown is passthrough, not exclusion.
   */
  readonly supportedModels?: readonly string[]
  /** Client model name -> this account's upstream name. Absent means pass the name through. */
  readonly modelAliases?: Readonly<Record<string, string>>
  /** Per-window quota state. Windows reset independently; the account is blocked by any spent one. */
  readonly quotaWindows?: readonly QuotaWindowState[]
  /**
   * What the last response's rate-limit headers said, under the limiter names the provider used.
   * Never filters an account — a limiter that hit zero has already cooled the breaker down — and
   * exists so `quota-aware` has a continuous reading to rank on. Absent means none was reported.
   */
  readonly limiterWindows?: readonly LimiterReading[]
  readonly health: AccountHealth
}

/** Weight and priority are properties of the membership, not of the account globally. */
export interface PoolMembership {
  readonly accountId: string
  readonly weight?: number
  readonly priority?: number
}

export interface PoolSnapshot {
  readonly id: string
  readonly name: string
  readonly policy: RoutingPolicy
  /** Declared order. It is the tiebreak for `priority-failover` and for every stable sort here. */
  readonly members: readonly PoolMembership[]
  /**
   * Optional member of last resort — typically a paid API key. It must be one of {@link members}:
   * the designation withholds that membership from the policy, it does not admit an account from
   * outside the pool. Used only when every other member is filtered out. Designating one *is* the
   * opt-in; there is no second switch.
   */
  readonly overflowAccountId?: string
  /** Per-pool request counter owned by the caller. Drives `round-robin` and `weighted` rotation. */
  readonly rotationCounter?: number
}

/** The presenting key's scope. Applied first, as an intersection, never widened. */
export type KeyScopeSnapshot =
  | { readonly kind: Extract<KeyScope, "all"> }
  | { readonly kind: Extract<KeyScope, "pools">; readonly poolIds: readonly string[] }
  | { readonly kind: Extract<KeyScope, "accounts">; readonly accountIds: readonly string[] }

/**
 * An existing Session -> Account binding. On the Agent-SDK path this is authoritative persisted
 * state, not a routing preference: an SDK session id is resumable only on the account that
 * created it. Selection takes it as an input and either honors it or says it must be invalidated.
 */
export interface SessionBinding {
  readonly accountId: string
  /** SDK path only. Meaningful only in the context of `accountId`; never carried elsewhere. */
  readonly sdkSessionId?: string
}

export interface SelectionRequest {
  /** Client-supplied session header verbatim, else the derived fingerprint. */
  readonly sessionKey: string
  /** The model the client asked for. Never re-ranked, never substituted. */
  readonly model: string
  readonly keyScope: KeyScopeSnapshot
  /** Present when this session already lives on an account. */
  readonly binding?: SessionBinding
  /** Fallback rotation counter for scopes that resolve outside any pool. */
  readonly rotationCounter?: number
}

export interface RoutingSnapshot {
  readonly accounts: readonly AccountSnapshot[]
  readonly pools: readonly PoolSnapshot[]
  /** The clock, injected. Nothing below reads `Date.now()`. */
  readonly now: Date
}

/**
 * Which load measure `least-used` ranks on. **DEFERRED** in the spec; the router defaults to
 * in-flight requests and uses recent token spend as the tiebreak.
 */
export type LeastUsedMeasure = "in-flight" | "recent-tokens"

/** What to do when a bound session's account is merely cooling down. */
export type BoundCooldownBehavior = "fail" | "rebind"

export interface SelectionOptions {
  /** Policy for groups that resolve outside a pool (`all` and `accounts` scopes). */
  readonly unpooledPolicy?: RoutingPolicy
  readonly leastUsedMeasure?: LeastUsedMeasure
  /** Utilization at or above which a window counts as spent. */
  readonly quotaSpentThreshold?: number
  /**
   * `fail` (default) prefers the honest 429 and keeps the binding — the conversation stays
   * resumable when the clock fixes the account. `rebind` invalidates it and starts fresh.
   */
  readonly boundAccountCoolingDown?: BoundCooldownBehavior
}

/** One in-scope account, carrying the membership values the policies rank on. */
export interface ScopedAccount {
  readonly account: AccountSnapshot
  /** The pool whose policy orders it; null when the scope resolved outside any pool. */
  readonly poolId: string | null
  readonly weight: number
  readonly priority: number
  /** Position in the declared order — the universal tiebreak. */
  readonly order: number
}

/** An account that survived filtering. */
export interface Candidate extends ScopedAccount {
  /** The model name to send upstream, after this account's alias map. */
  readonly upstreamModel: string
  /** True when this is a breaker half-open probe rather than a healthy pick. */
  readonly halfOpen: boolean
}

/** A scope-resolved group. The policy runs *within* a group, never across the union of groups. */
export interface ScopeGroup {
  readonly poolId: string | null
  readonly poolName: string | null
  readonly policy: RoutingPolicy
  readonly rotationCounter: number
  readonly members: readonly ScopedAccount[]
  /** In-scope overflow member, or null. Invisible to the policy until the group filters empty. */
  readonly overflow: ScopedAccount | null
}

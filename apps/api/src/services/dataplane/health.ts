import type { AuthKind, QuotaWindowState } from "@multi-ai-router/core"
import type { RateLimitSignal, RateLimitWindow } from "../../providers"
import {
  type AttemptFailure,
  type BreakerOptions,
  type BreakerState,
  HEALTHY,
  phase,
  recordFailure,
  recordSuccess,
  withPlanReset,
} from "../routing"
import { mergeQuotaWindows } from "../routing/quota"
import {
  createHealthObservations,
  type HealthAccountFacts,
  type HealthObservation,
} from "./health-observation"
import { configuredBreaker, type HealthStoreOptions } from "./health-options"
import { foldRateLimit } from "./health-reading"
import { recoverHealth } from "./health-recovery"
import { rotateTokens, type TokenWindow } from "./health-tokens"

export interface AccountHealthState {
  readonly breaker: BreakerState
  readonly inFlight: number
  /** Output tokens over the last one to two `tokenWindowMs` windows (02.10); since boot without one. */
  readonly recentTokens: number
  /** The two buckets `recentTokens` sums, when a window is configured. */
  readonly tokenWindow?: TokenWindow
  readonly limiterWindows: readonly RateLimitWindow[]
  readonly quotaWindows: readonly QuotaWindowState[]
  readonly lastSignalAt: Date | null
  readonly probeHeldUntil: Date | null
  /** Upstream models this account answered `model-unsupported` for, each until its expiry (10.16). */
  readonly refusedModels?: ReadonlyMap<string, Date>
}

const FRESH: AccountHealthState = {
  breaker: HEALTHY,
  inFlight: 0,
  recentTokens: 0,
  limiterWindows: [],
  quotaWindows: [],
  lastSignalAt: null,
  probeHeldUntil: null,
}

export const DEFAULT_PROBE_HOLD_MS = 30_000

export type { HealthStoreOptions } from "./health-options"

export interface ProbeAdmission {
  readonly admitted: boolean
  readonly held: boolean
  readonly token?: number
}

const ADMITTED_WITHOUT_HOLD: ProbeAdmission = { admitted: true, held: false }
const REFUSED: ProbeAdmission = { admitted: false, held: false }

export interface HealthStore {
  stateOf(accountId: string): AccountHealthState
  reconcile(accountId: string, facts: HealthAccountFacts): void
  acceptsObservation(accountId: string, observation: HealthObservation): boolean
  captureAttempt(accountId: string, facts: HealthAccountFacts): HealthObservation
  beginAttempt(accountId: string): void
  endAttempt(accountId: string, tokens?: number): void
  recordSuccess(accountId: string, observation?: HealthObservation): void
  recordFailure(
    accountId: string,
    failure: AttemptFailure,
    now: Date,
    options?: BreakerOptions,
    observation?: HealthObservation,
  ): void
  applyRateLimit(
    accountId: string,
    signal: RateLimitSignal | null,
    now: Date,
    observation?: HealthObservation,
  ): void
  /** Keeps `upstreamModel` off this account for `modelRefusalTtlMs` after it refused it. */
  refuseModel(accountId: string, upstreamModel: string, now: Date): void
  admitProbe(accountId: string, now: Date): ProbeAdmission
  releaseProbe(accountId: string, token?: number): void
  probeStats(): { readonly admitted: number; readonly refused: number }
  reset(accountId: string): void
  entries(): ReadonlyMap<string, AccountHealthState>
}

export function createHealthStore(options: HealthStoreOptions = {}): HealthStore {
  const states = new Map<string, AccountHealthState>()
  const observations = createHealthObservations()
  // Weak ownership keeps evidence tied to the exact captured attempt, not its account overlay.
  const acceptedQuota = new WeakMap<HealthObservation, readonly QuotaWindowState[]>()
  const probeTokens = new Map<string, number>()
  let nextProbeToken = 0
  const jitter = options.jitter ?? Math.random
  const probeHoldMs = options.probeHoldMs ?? DEFAULT_PROBE_HOLD_MS
  const planReadingMaxAgeMs = options.planReadingMaxAgeMs ?? 0
  let probeAdmitted = 0
  let probeRefused = 0

  const configured = configuredBreaker(options)

  const breakerOptions = (caller?: BreakerOptions): BreakerOptions => ({
    ...configured,
    jitter: jitter(),
    ...caller,
  })

  const tokenWindowMs = options.tokenWindowMs
  const elapsed = options.elapsed ?? (() => performance.now())
  const read = (accountId: string): AccountHealthState => {
    const state = states.get(accountId) ?? FRESH
    if (tokenWindowMs === undefined || state.tokenWindow === undefined) return state
    const window = rotateTokens(state.tokenWindow, elapsed(), tokenWindowMs)
    if (window === state.tokenWindow) return state
    const rotated = {
      ...state,
      tokenWindow: window,
      recentTokens: window.previous + window.current,
    }
    states.set(accountId, rotated)
    return rotated
  }
  const write = (accountId: string, patch: Partial<AccountHealthState>): void => {
    states.set(accountId, { ...read(accountId), ...patch })
  }

  return {
    stateOf: read,
    reconcile(accountId, facts) {
      const kind = observations.reconcile(accountId, facts)
      if (kind === null) return
      const previous = read(accountId)
      const recovered = recoverHealth(previous, kind, facts)
      if (recovered !== previous) {
        states.set(accountId, recovered)
        probeTokens.delete(accountId)
      }
    },
    captureAttempt: observations.capture,
    acceptsObservation: observations.accepts,

    beginAttempt(accountId) {
      write(accountId, { inFlight: read(accountId).inFlight + 1 })
    },

    endAttempt(accountId, tokens = 0) {
      const current = read(accountId)
      const inFlight = Math.max(0, current.inFlight - 1)
      if (tokenWindowMs === undefined) {
        write(accountId, { inFlight, recentTokens: current.recentTokens + tokens })
        return
      }
      const window = current.tokenWindow ?? { start: elapsed(), previous: 0, current: 0 }
      const tokenWindow = { ...window, current: window.current + tokens }
      write(accountId, {
        inFlight,
        tokenWindow,
        recentTokens: tokenWindow.previous + tokenWindow.current,
      })
    },

    recordSuccess(accountId, observation) {
      const before = read(accountId).breaker
      if (
        before.status === "exhausted" ||
        before.status === "needs_reauth" ||
        before.status === "disabled"
      )
        return
      if (!observations.acceptsSuccess(accountId, observation)) return
      write(accountId, { breaker: recordSuccess() })
    },

    recordFailure(accountId, failure, now, caller, observation) {
      if (!observations.accepts(accountId, observation)) return
      const before = read(accountId).breaker
      if (phase(before, now) === "blocked") return
      // A limit refusal with no reset of its own lasts until the plan's reading says it lifts.
      const planned = withPlanReset(failure, read(accountId).quotaWindows, now, planReadingMaxAgeMs)
      const after = recordFailure(before, planned, now, breakerOptions(caller))
      if (after !== before) observations.advanceVerdict(accountId)
      write(accountId, { breaker: after })
      if (after.status !== before.status && phase(after, now) === "blocked") {
        options.onBlocked?.(
          accountId,
          after.status,
          observation,
          observation === undefined ? undefined : acceptedQuota.get(observation),
        )
      }
    },

    applyRateLimit(accountId, signal, now, observation) {
      if (signal === null || !observations.accepts(accountId, observation)) return
      const folded = foldRateLimit(
        read(accountId),
        signal,
        now,
        breakerOptions(),
        planReadingMaxAgeMs,
      )
      if (folded.breaker !== read(accountId).breaker) observations.advanceVerdict(accountId)
      states.set(accountId, folded)
      if (signal.quotaWindows !== undefined) {
        if (observation !== undefined)
          acceptedQuota.set(
            observation,
            mergeQuotaWindows(acceptedQuota.get(observation) ?? [], signal.quotaWindows),
          )
        options.onQuotaWindows?.(
          accountId,
          observation === undefined ? folded.quotaWindows : (acceptedQuota.get(observation) ?? []),
          observation,
        )
      }
    },

    refuseModel(accountId, upstreamModel, now) {
      const ttlMs = options.modelRefusalTtlMs
      if (ttlMs === undefined) return
      const kept = [...(read(accountId).refusedModels ?? [])].filter(([, until]) => until > now)
      kept.push([upstreamModel, new Date(now.getTime() + ttlMs)])
      write(accountId, { refusedModels: new Map(kept) })
    },

    admitProbe(accountId, now) {
      const state = read(accountId)
      const live = phase(state.breaker, now)
      if (live === "closed") return ADMITTED_WITHOUT_HOLD
      if (live !== "half-open") return REFUSED

      const held = state.probeHeldUntil
      if (held !== null && held.getTime() > now.getTime()) {
        probeRefused += 1
        return REFUSED
      }

      write(accountId, { probeHeldUntil: new Date(now.getTime() + probeHoldMs) })
      const token = ++nextProbeToken
      probeTokens.set(accountId, token)
      probeAdmitted += 1
      return { admitted: true, held: true, token }
    },

    releaseProbe(accountId, token) {
      if (token !== undefined && probeTokens.get(accountId) !== token) return
      probeTokens.delete(accountId)
      if (states.has(accountId)) write(accountId, { probeHeldUntil: null })
    },

    probeStats: () => ({ admitted: probeAdmitted, refused: probeRefused }),

    reset(accountId) {
      states.delete(accountId)
      observations.forget(accountId)
      probeTokens.delete(accountId)
      options.onReset?.(accountId)
    },

    entries: () => states,
  }
}

export function breakerOptionsFor(authKind: AuthKind): BreakerOptions {
  return { authKind }
}

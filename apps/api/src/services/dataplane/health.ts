import type { AccountStatus, AuthKind, QuotaWindowState } from "@multi-ai-router/core"
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
import { mergeQuotaWindows } from "../routing/quota"
import {
  createHealthObservations,
  type HealthAccountFacts,
  type HealthObservation,
} from "./health-observation"
import { foldRateLimit } from "./health-reading"
import { recoverHealth } from "./health-recovery"

export interface AccountHealthState {
  readonly breaker: BreakerState
  readonly inFlight: number
  readonly recentTokens: number
  readonly limiterWindows: readonly RateLimitWindow[]
  readonly quotaWindows: readonly QuotaWindowState[]
  readonly lastSignalAt: Date | null
  readonly probeHeldUntil: Date | null
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

export interface HealthStoreOptions {
  readonly failureThreshold?: number
  readonly baseBackoffMs?: number
  readonly maxBackoffMs?: number
  readonly authFailureCooldownMs?: number
  readonly authFailureMaxCooldownMs?: number
  readonly jitter?: () => number
  readonly probeHoldMs?: number
  readonly onQuotaWindows?: (
    accountId: string,
    windows: readonly QuotaWindowState[],
    observation?: HealthObservation,
  ) => void
  readonly onBlocked?: (
    accountId: string,
    status: AccountStatus,
    observation?: HealthObservation,
    quotaWindows?: readonly QuotaWindowState[],
  ) => void
  readonly onReset?: (accountId: string) => void
}

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
  let probeAdmitted = 0
  let probeRefused = 0

  const configured: BreakerOptions = {
    ...(options.failureThreshold === undefined
      ? {}
      : { failureThreshold: options.failureThreshold }),
    ...(options.baseBackoffMs === undefined ? {} : { baseBackoffMs: options.baseBackoffMs }),
    ...(options.maxBackoffMs === undefined ? {} : { maxBackoffMs: options.maxBackoffMs }),
    ...(options.authFailureCooldownMs === undefined
      ? {}
      : { authFailureCooldownMs: options.authFailureCooldownMs }),
    ...(options.authFailureMaxCooldownMs === undefined
      ? {}
      : { authFailureMaxCooldownMs: options.authFailureMaxCooldownMs }),
  }

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
      write(accountId, {
        inFlight: Math.max(0, current.inFlight - 1),
        recentTokens: current.recentTokens + tokens,
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
      const after = recordFailure(before, failure, now, breakerOptions(caller))
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
      const folded = foldRateLimit(read(accountId), signal, now, breakerOptions())
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

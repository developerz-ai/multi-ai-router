import type { AuthKind, QuotaWindowState } from "@multi-ai-router/core"
import type { AccountBreakerRow } from "@multi-ai-router/db"
import type { RateLimitSignal } from "../../providers"
import {
  type AttemptFailure,
  type BreakerOptions,
  type BreakerState,
  phase,
  recordFailure,
  recordSuccess,
  withPlanReset,
} from "../routing"
import { verifiedKeyCapReset } from "../routing/plan-reset"
import { mergeQuotaWindows } from "../routing/quota"
import { createHealthDurability } from "./health-durability"
import { refuseHeld, throttleHeld } from "./health-model-holds"
import {
  createHealthObservations,
  type HealthAccountFacts,
  type HealthObservation,
} from "./health-observation"
import { configuredBreaker, type HealthStoreOptions } from "./health-options"
import { foldRateLimit } from "./health-reading"
import { type AccountHealthState, FRESH } from "./health-state"
import { rotateTokens } from "./health-tokens"

export type { AccountHealthState } from "./health-state"

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
  /**
   * The same verified, fresh `spend_limit` reset the breaker uses to cool a key-cap refusal, for the
   * client error path. `null` means the evidence does not support a reset; no instant is invented.
   */
  keyCapResetAt(accountId: string, now: Date): Date | null
  reconcile(accountId: string, facts: HealthAccountFacts): void
  acknowledgeBreaker(accountId: string, breaker: BreakerState, row: AccountBreakerRow): void
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
  /**
   * A throttle on one model only: holds `upstreamModel` off this account until the failure's reset,
   * or the breaker's backoff stepped per repeat, and leaves the account's own breaker untouched.
   */
  throttleModel(
    accountId: string,
    upstreamModel: string,
    failure: AttemptFailure,
    now: Date,
    caller?: BreakerOptions,
  ): void
  admitProbe(accountId: string, now: Date): ProbeAdmission
  releaseProbe(accountId: string, token?: number): void
  /** The live probe hold's own expiry, else a whole fresh hold from `now`: the honest wait. */
  probeHoldUntil(accountId: string, now: Date): Date
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
  const durability = createHealthDurability(
    observations,
    read,
    (id, state) => {
      states.set(id, state)
      if (state.probeHeldUntil === null) probeTokens.delete(id)
    },
    (id) => probeTokens.has(id),
    options,
  )
  const publish = durability.publish

  return {
    stateOf: read,
    keyCapResetAt(accountId, now) {
      return verifiedKeyCapReset(read(accountId).quotaWindows, now, planReadingMaxAgeMs)
    },
    acknowledgeBreaker: durability.acknowledgeBreaker,
    reconcile: durability.reconcile,
    captureAttempt: durability.captureAttempt,
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
      publish(accountId, read(accountId).breaker, observation)
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
      publish(accountId, after, observation)
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
      const held = read(accountId)
      const folded = foldRateLimit(held, signal, now, breakerOptions(), planReadingMaxAgeMs)
      states.set(accountId, folded)
      // Republishing an unmoved verdict bumps the revision that fences this response's own success.
      if (folded.breaker !== held.breaker) {
        observations.advanceVerdict(accountId)
        publish(accountId, folded.breaker, observation)
      }
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
      write(accountId, { refusedModels: refuseHeld(read(accountId), upstreamModel, now, ttlMs) })
    },

    throttleModel(accountId, upstreamModel, failure, now, caller) {
      const held = throttleHeld(
        read(accountId),
        upstreamModel,
        failure,
        now,
        breakerOptions(caller),
      )
      write(accountId, { refusedModels: held })
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

      const heldUntil = new Date(now.getTime() + probeHoldMs)
      write(accountId, { probeHeldUntil: heldUntil })
      const token = ++nextProbeToken
      probeTokens.set(accountId, token)
      probeAdmitted += 1
      durability.publishHold(accountId, heldUntil)
      return { admitted: true, held: true, token }
    },

    releaseProbe(accountId, token) {
      if (token !== undefined && probeTokens.get(accountId) !== token) return
      probeTokens.delete(accountId)
      if (states.has(accountId)) write(accountId, { probeHeldUntil: null })
      durability.publishHold(accountId, null)
    },

    probeHoldUntil(accountId, now) {
      const held = read(accountId).probeHeldUntil
      return held !== null && held > now ? held : new Date(now.getTime() + probeHoldMs)
    },

    probeStats: () => ({ admitted: probeAdmitted, refused: probeRefused }),

    reset(accountId) {
      // Nothing durable to release: both callers reset an account that is already gone from the
      // catalog, and their `onReset` forgets this id's queued breaker and hold writes before any
      // flush, so a release published here would reach Postgres as nothing.
      states.delete(accountId)
      observations.forget(accountId)
      durability.forget(accountId)
      probeTokens.delete(accountId)
      options.onReset?.(accountId)
    },

    entries: () => states,
  }
}

export function breakerOptionsFor(authKind: AuthKind): BreakerOptions {
  return { authKind }
}

import { type AccountBreakerRow, credentialFingerprint } from "@multi-ai-router/db"
import type { BreakerState } from "../routing"
import type { AccountHealthState } from "./health"
import type {
  createHealthObservations,
  HealthAccountFacts,
  HealthObservation,
} from "./health-observation"
import type { HealthStoreOptions } from "./health-options"
import { recoverHealth } from "./health-recovery"

/** Keeps local unacknowledged restrictions ahead of older catalog snapshots. */
export function createHealthDurability(
  observations: ReturnType<typeof createHealthObservations>,
  read: (id: string) => AccountHealthState,
  install: (id: string, state: AccountHealthState) => void,
  probeInFlight: (id: string) => boolean,
  options: HealthStoreOptions,
) {
  const dirty = new Map<string, BreakerState>()
  const factsById = new Map<string, HealthAccountFacts>()
  const durability = {
    publish(id: string, breaker: BreakerState, observation?: HealthObservation) {
      if (observation === undefined) return
      dirty.set(id, breaker)
      options.onBreaker?.(id, breaker, observation)
    },
    /**
     * A hold taken or dropped on this replica. Published through the breaker's own off-path flush, so
     * the request path still never touches Postgres (non-negotiable 8).
     */
    publishHold(id: string, heldUntil: Date | null) {
      const facts = factsById.get(id)
      if (facts === undefined) return
      options.onProbeHold?.(id, heldUntil, observations.capture(id, facts))
    },
    acknowledgeBreaker(id: string, breaker: BreakerState, row: AccountBreakerRow) {
      const facts = factsById.get(id)
      if (
        facts === undefined ||
        row.accountId !== id ||
        row.credentialFingerprint !== credentialFingerprint(facts.authMaterial) ||
        row.lifecycleVersion !== facts.lifecycleVersion ||
        row.healthRecoveryVersion !== facts.healthRecoveryVersion ||
        row.authRecoveryVersion !== facts.authRecoveryVersion
      )
        return
      if ((facts.breaker?.revision ?? 0) > row.revision) return
      if (dirty.get(id) === breaker) dirty.delete(id)
      if ((facts.breaker?.revision ?? 0) === row.revision) return
      const next = { ...facts, breaker: row }
      durability.reconcile(id, next)
    },
    reconcile(accountId: string, facts: HealthAccountFacts) {
      // A hold-only change still bumps the row revision, so `sameAccountFacts` reports it as `none`
      // rather than `null`; `null` really is nothing to install.
      const kind = observations.reconcile(accountId, facts)
      if (kind === null) return
      factsById.set(accountId, facts)
      const previous = read(accountId)
      let recovered = recoverHealth(previous, kind === "none" ? null : kind, facts)
      if (recovered.breaker !== previous.breaker) dirty.delete(accountId)
      const row = facts.breaker
      if (
        row !== undefined &&
        facts.status !== "disabled" &&
        facts.status !== "exhausted" &&
        facts.status !== "needs_reauth"
      ) {
        const local = dirty.get(accountId)
        if (
          local === undefined ||
          (local.status !== "exhausted" &&
            local.status !== "needs_reauth" &&
            (row.status === "exhausted" ||
              row.status === "needs_reauth" ||
              (row.cooldownUntil !== null &&
                (local.cooldownUntil === undefined || row.cooldownUntil > local.cooldownUntil))))
        ) {
          recovered = {
            ...recovered,
            breaker: {
              status: row.status,
              consecutiveFailures: row.consecutiveFailures,
              cooldownSource: row.cooldownSource,
              ...(row.cooldownUntil === null ? {} : { cooldownUntil: row.cooldownUntil }),
              ...(row.cooldownReason === null ? {} : { cooldownReason: row.cooldownReason }),
            },
          }
        }
      }
      if (recovered !== previous) install(accountId, recovered)
      // A hold another replica took is honoured here; a release it published clears this replica's
      // copy. A probe in flight *here* is the newest fact and wins until it publishes or finishes.
      const durableHold = row?.probeHeldUntil ?? null
      const current = read(accountId)
      const local = probeInFlight(accountId) ? current.probeHeldUntil : null
      const next =
        durableHold === null || (local !== null && local > durableHold) ? local : durableHold
      if ((current.probeHeldUntil?.getTime() ?? null) !== (next?.getTime() ?? null)) {
        install(accountId, { ...current, probeHeldUntil: next })
      }
    },
    captureAttempt(accountId: string, facts: HealthAccountFacts) {
      if (!factsById.has(accountId)) durability.reconcile(accountId, facts)
      return observations.capture(accountId, facts)
    },
    forget(accountId: string) {
      factsById.delete(accountId)
      dirty.delete(accountId)
    },
  }
  return durability
}

import type { AccountStatus } from "@multi-ai-router/core"

/** Durable facts from the unmodified catalog row; never a health overlay. */
export interface HealthAccountFacts {
  readonly lifecycleVersion: number
  readonly healthRecoveryVersion: number
  readonly authRecoveryVersion: number
  readonly authMaterial: string | null
  readonly status: AccountStatus
}

/** Project only durable facts; do not retain driver, quota, or routing snapshots in observations. */
export function accountHealthFacts(
  account: Omit<HealthAccountFacts, "status"> & {
    readonly snapshot: { readonly status: AccountStatus }
  },
): HealthAccountFacts {
  return {
    lifecycleVersion: account.lifecycleVersion,
    healthRecoveryVersion: account.healthRecoveryVersion,
    authRecoveryVersion: account.authRecoveryVersion,
    authMaterial: account.authMaterial,
    status: account.snapshot.status,
  }
}

export interface HealthObservation extends HealthAccountFacts {
  readonly observationGeneration: number
  readonly verdictVersion: number
}

export function sameAccountFacts(left: HealthAccountFacts, right: HealthAccountFacts): boolean {
  return (
    left.lifecycleVersion === right.lifecycleVersion &&
    left.healthRecoveryVersion === right.healthRecoveryVersion &&
    left.authRecoveryVersion === right.authRecoveryVersion &&
    left.authMaterial === right.authMaterial &&
    left.status === right.status
  )
}

/** Independent epochs survive replicas missing intermediate commits. */
export function recoveryKind(
  before: HealthAccountFacts | undefined,
  after: HealthAccountFacts,
): "full" | "authentication" | null {
  if (before === undefined) return null
  if (after.healthRecoveryVersion > before.healthRecoveryVersion) return "full"
  if (after.status === "disabled" || after.status === "exhausted") return null
  if (
    after.authRecoveryVersion > before.authRecoveryVersion ||
    (after.status === "active" && after.authMaterial !== before.authMaterial)
  ) {
    return "authentication"
  }
  return null
}

/** The freshest captured observation wins, irrespective of callback arrival order. */
export function newerObservation(left: HealthObservation, right: HealthObservation): boolean {
  return (
    left.observationGeneration > right.observationGeneration ||
    (left.observationGeneration === right.observationGeneration &&
      left.lifecycleVersion > right.lifecycleVersion)
  )
}

interface HeldObservation {
  readonly facts: HealthAccountFacts
  readonly generation: number
  verdictVersion: number
}

/** Local ordering over durable facts. Catalog installation is the only reconciliation authority. */
export function createHealthObservations() {
  const held = new Map<string, HeldObservation>()
  let generation = 0
  const reconcile = (accountId: string, facts: HealthAccountFacts) => {
    const previous = held.get(accountId)
    if (previous !== undefined && sameAccountFacts(previous.facts, facts)) return null
    // A preselected request must never move health backwards across an operator mutation.
    if (previous !== undefined && facts.lifecycleVersion < previous.facts.lifecycleVersion)
      return null
    const kind = recoveryKind(previous?.facts, facts)
    held.set(accountId, {
      facts,
      generation: ++generation,
      verdictVersion: previous?.verdictVersion ?? 0,
    })
    return kind
  }
  const accepts = (accountId: string, observation?: HealthObservation): boolean => {
    if (observation === undefined) return true
    const current = held.get(accountId)
    return (
      current !== undefined &&
      current.generation === observation.observationGeneration &&
      sameAccountFacts(current.facts, observation)
    )
  }
  return {
    reconcile,
    capture(accountId: string, facts: HealthAccountFacts): HealthObservation {
      // Existing facts may be newer than this plan, especially after a same-L token rotation.
      if (!held.has(accountId)) reconcile(accountId, facts)
      const current = held.get(accountId)
      return {
        lifecycleVersion: facts.lifecycleVersion,
        healthRecoveryVersion: facts.healthRecoveryVersion,
        authRecoveryVersion: facts.authRecoveryVersion,
        authMaterial: facts.authMaterial,
        status: facts.status,
        observationGeneration: current?.generation ?? 0,
        verdictVersion: current?.verdictVersion ?? 0,
      }
    },
    accepts,
    acceptsSuccess(accountId: string, observation?: HealthObservation): boolean {
      return (
        accepts(accountId, observation) &&
        (observation === undefined ||
          held.get(accountId)?.verdictVersion === observation.verdictVersion)
      )
    },
    advanceVerdict(accountId: string): void {
      const current = held.get(accountId)
      if (current !== undefined) current.verdictVersion += 1
    },
    forget(accountId: string): void {
      held.delete(accountId)
    },
  }
}

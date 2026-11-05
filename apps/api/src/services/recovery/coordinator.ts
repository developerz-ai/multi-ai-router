import type { AccountObservation, AccountRow } from "@multi-ai-router/db"
import { createRecoveryLoop } from "./loop"
import { createRecoveryQueues } from "./queues"
import type {
  RecoveryCapability,
  RecoveryCoordinator,
  RecoveryCoordinatorDeps,
  RecoveryOutcome,
  RecoveryRow,
} from "./types"

function observation(row: AccountRow): AccountObservation {
  return {
    lifecycleVersion: row.lifecycleVersion,
    authMaterial: row.authMaterial,
    status: row.status,
  }
}
export function createRecoveryCoordinator(deps: RecoveryCoordinatorDeps): RecoveryCoordinator {
  const bootId = crypto.randomUUID()
  const queues = createRecoveryQueues(deps.config.demandCapacity, deps.config.outcomeCapacity)
  // Retain the last offered permit across stop/start. Consumed capabilities never reinstall.
  const offered = new Map<string, string>()
  let flight: Promise<void> | undefined
  let stopped = false
  let issuanceClosed = false
  let dirty = false
  let stopping: Promise<void> | undefined
  const coherent = async (): Promise<boolean> => {
    if (stopped) return false
    if (!dirty) return true
    try {
      await deps.refreshCatalogAfterMutation()
      dirty = false
      return !stopped
    } catch (error) {
      deps.warn("recovery catalog reconciliation failed; capabilities remain gated", error)
      return false
    }
  }
  const expose = async (row: RecoveryRow): Promise<void> => {
    if (stopped || row.state !== "issued" || row.ownerBootId !== bootId || row.permitId === null)
      return
    if (offered.get(row.accountId) === row.permitId) return
    const account = await deps.accounts.findById(row.accountId)
    if (
      stopped ||
      account === undefined ||
      account.status === "disabled" ||
      account.status === "needs_reauth" ||
      account.status === "exhausted"
    )
      return
    const hydrated = await deps.repository.hydrateIssued({
      accountId: row.accountId,
      generation: row.generation,
      permitId: row.permitId,
      ownerBootId: bootId,
      expectedEpoch: row.ownershipEpoch,
      expected: observation(account),
      maximumOutcomeAgeMs: deps.config.maximumOutcomeMs,
    })
    if (hydrated === undefined || !(await coherent()) || stopped) return
    const capability: RecoveryCapability = {
      revision: hydrated.revision,
      accountId: row.accountId,
      generation: row.generation,
      permitId: row.permitId,
      ownerBootId: bootId,
      ownershipEpoch: row.ownershipEpoch,
      expected: observation(account),
      quotaRevisions: { ...row.quotaRevisions },
    }
    // Install is synchronous and must be idempotent; a consumed permit cannot be reset.
    if (!deps.install(capability)) {
      dirty = true
      return
    }
    offered.set(row.accountId, row.permitId)
    queues.satisfied(row.accountId)
  }
  const issuing = (): boolean => !stopped && !issuanceClosed
  const writeOutcome = async (outcome: RecoveryOutcome): Promise<void> => {
    const { ownershipEpoch, ...rest } = outcome
    dirty = true
    const committed = await deps.repository.outcome({
      ...rest,
      expectedEpoch: ownershipEpoch,
      ownerBootId: bootId,
      cooldownMs: deps.config.cooldownMs,
      quotaSpentThreshold: deps.config.quotaSpentThreshold,
    })
    // Undefined means fenced by newer account/generation; never resend a provider probe.
    queues.completed(outcome)
    if (committed !== undefined) dirty = true
    deps.retire(outcome.accountId, outcome.generation)
  }
  /**
   * No later boot hydrates this boot's permits, so one left `issued` gates its account until the
   * maximum-outcome bound. Observed verdicts go first; whatever has none proved nothing: uncertain.
   */
  const settle = async (expired: () => boolean): Promise<void> => {
    for (const outcome of queues.batch(deps.config.outcomeCapacity)) {
      if (expired()) return
      try {
        await writeOutcome(outcome)
      } catch (error) {
        deps.warn("recovery outcome lost during shutdown; settling it as uncertain", error)
      }
    }
    try {
      let rows: RecoveryRow[]
      do {
        if (expired()) return
        rows = await deps.repository.settleIssuedForOwner({
          limit: deps.config.batchSize,
          ownerBootId: bootId,
          cooldownMs: deps.config.cooldownMs,
        })
        for (const row of rows) deps.retire(row.accountId, row.generation)
      } while (rows.length === deps.config.batchSize)
    } catch (error) {
      deps.warn("recovery permits not settled; they wait out the maximum outcome bound", error)
    }
  }
  const work = async (): Promise<void> => {
    await coherent()
    if (issuing()) deps.reopen()
    for (const request of queues.automaticBatch(deps.config.batchSize)) {
      if (stopped) return
      dirty = true
      await deps.repository.beginAutomaticRecovery({
        ...request,
        cooldownMs: deps.config.cooldownMs,
        maximumOutcomeAgeMs: deps.config.maximumOutcomeMs,
      })
      queues.automaticCompleted(request)
    }
    for (const outcome of queues.batch(deps.config.batchSize)) {
      if (stopped) return
      await writeOutcome(outcome)
    }
    await coherent()
    if (stopped) return
    const expiredRows = await deps.repository.listExpiredIssued({
      limit: deps.config.batchSize,
      maximumOutcomeAgeMs: deps.config.maximumOutcomeMs,
    })
    for (const row of expiredRows) {
      if (stopped) return
      if (row.permitId === null) continue
      const expired = await deps.repository.markUncertain({
        accountId: row.accountId,
        generation: row.generation,
        permitId: row.permitId,
        maximumOutcomeAgeMs: deps.config.maximumOutcomeMs,
      })
      if (expired !== undefined) {
        dirty = true
        deps.retire(row.accountId, row.generation)
      }
    }
    if (stopped) return
    const demandedIds = queues.demandIds(deps.now().getTime(), deps.config.demandTtlMs)
    const issued = await deps.repository.listIssuedForOwner({
      limit: deps.config.batchSize,
      ownerBootId: bootId,
      accountIds: demandedIds,
    })
    for (const row of issued) {
      if (stopped) return
      await expose(row)
    }
    if (!issuing()) return
    const pending = await deps.repository.listPending({
      limit: deps.config.batchSize,
      accountIds: demandedIds,
    })
    for (const row of pending) {
      if (!issuing()) return
      if (!queues.demanded(row.accountId, deps.now().getTime(), deps.config.demandTtlMs)) continue
      const assigned = await deps.repository.assignPending({
        accountId: row.accountId,
        generation: row.generation,
        expectedEpoch: row.ownershipEpoch,
        ownerBootId: bootId,
        leaseMs: deps.config.preparationLeaseMs,
      })
      if (!issuing() || assigned === undefined || assigned.ownerBootId !== bootId) continue
      const account = await deps.accounts.findById(row.accountId)
      if (
        !issuing() ||
        account === undefined ||
        account.lifecycleVersion !== assigned.lifecycleVersion ||
        account.status === "disabled" ||
        account.status === "needs_reauth" ||
        account.status === "exhausted"
      )
        continue
      dirty = true
      const committed = await deps.repository.issue({
        accountId: row.accountId,
        generation: row.generation,
        expectedEpoch: assigned.ownershipEpoch,
        ownerBootId: bootId,
        permitId: crypto.randomUUID(),
        expected: observation(account),
      })
      // Issuance acknowledgment loss is resolved by listIssued on the next tick, never reissued.
      if (committed !== undefined) {
        dirty = true
        await expose(committed)
      }
    }
    await coherent()
  }
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (flight !== undefined) return flight
    const owned = work()
      .catch((error) => deps.warn("recovery coordination failed; retrying off path", error))
      .finally(() => {
        if (flight === owned) flight = undefined
      })
    flight = owned
    return owned
  }
  const loop = createRecoveryLoop({
    schedule: deps.schedule,
    intervalMs: deps.config.intervalMs,
    tick,
    stopped: () => stopped,
  })
  return {
    bootId,
    forget: (id) => {
      offered.delete(id)
      queues.forget(id)
    },
    requestAutomatic: (request) => !stopped && queues.automatic(request),
    demand: (id) => {
      if (!stopped) queues.demand(id, deps.now().getTime())
    },
    recordOutcome: (outcome) => !stopped && queues.outcome(outcome),
    closeIssuance: () => {
      issuanceClosed = true
    },
    tick,
    start: () => {
      if (stopping !== undefined || flight !== undefined) return
      stopped = false
      issuanceClosed = false
      loop.start()
    },
    stop: () => {
      if (stopping !== undefined) return stopping
      stopped = true
      loop.stop()
      const inFlight = flight
      let expired = false
      let cancelDeadline: () => void = () => undefined
      const deadline = new Promise<void>((resolve) => {
        cancelDeadline = deps.schedule(() => {
          deps.warn(
            "recovery coordinator drain timed out; unsettled permits wait out the maximum outcome bound",
          )
          expired = true
          resolve()
        }, deps.config.shutdownDrainMs)
      })
      // At once, so a flight stalled on the catalog cannot spend the budget; again after it, so a
      // permit whose issue was already committing when stop began is not stranded.
      const isExpired = () => expired
      const drain = settle(isExpired).then(async () => {
        if (inFlight === undefined) return
        await inFlight
        await settle(isExpired)
      })
      const owned = Promise.race([drain, deadline]).finally(cancelDeadline)
      stopping = owned
      // A restart waits for the drain itself, not the deadline: a sweep still running could mark
      // the new run's permits uncertain.
      void drain
        .catch(() => undefined)
        .finally(() => {
          stopping = undefined
        })
      return owned
    },
  }
}

import type { AccountObservation, AccountRow } from "@multi-ai-router/db"
import { createRecoveryLoop } from "./loop"
import { createRecoveryQueues } from "./queues"
import type {
  RecoveryCapability,
  RecoveryCoordinator,
  RecoveryCoordinatorDeps,
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
  const work = async (): Promise<void> => {
    await coherent()
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
    if (stopped) return
    const pending = await deps.repository.listPending({
      limit: deps.config.batchSize,
      accountIds: demandedIds,
    })
    for (const row of pending) {
      if (stopped) return
      if (!queues.demanded(row.accountId, deps.now().getTime(), deps.config.demandTtlMs)) continue
      const assigned = await deps.repository.assignPending({
        accountId: row.accountId,
        generation: row.generation,
        expectedEpoch: row.ownershipEpoch,
        ownerBootId: bootId,
        leaseMs: deps.config.preparationLeaseMs,
      })
      if (stopped || assigned === undefined || assigned.ownerBootId !== bootId) continue
      const account = await deps.accounts.findById(row.accountId)
      if (
        stopped ||
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
    tick,
    start: () => {
      if (stopping !== undefined || flight !== undefined) return
      stopped = false
      loop.start()
    },
    stop: () => {
      if (stopping !== undefined) return stopping
      stopped = true
      loop.stop()
      let cancelDeadline: () => void = () => undefined
      const deadline = new Promise<void>((resolve) => {
        cancelDeadline = deps.schedule(() => {
          deps.warn("recovery coordinator drain timed out; issued outcomes remain uncertain")
          resolve()
        }, deps.config.shutdownDrainMs)
      })
      const owned = Promise.race([flight ?? Promise.resolve(), deadline]).finally(() => {
        cancelDeadline()
        stopping = undefined
      })
      stopping = owned
      return owned
    },
  }
}

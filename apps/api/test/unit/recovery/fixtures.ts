import type { AccountRow } from "@multi-ai-router/db"
import { createRecoveryCoordinator } from "../../../src/services/recovery/coordinator"
import type {
  RecoveryCapability,
  RecoveryCoordinatorDeps,
  RecoveryRow,
} from "../../../src/services/recovery/types"

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
export function fixture() {
  let row: RecoveryRow = {
    accountId: "account",
    revision: 0,
    generation: "generation",
    lifecycleVersion: 1,
    credentialFingerprint: "fixture",
    state: "pending",
    ownerBootId: null,
    ownershipEpoch: 0,
    permitId: null,
    quotaRevisions: { five_hour: 1 },
    reason: "operator-recheck",
    requestedAt: new Date(0),
    nextAllowedAt: new Date(0),
    preparationLeaseUntil: null,
    issuedAt: null,
    outcomeAt: null,
  }
  const account = {
    id: "account",
    lifecycleVersion: 1,
    authMaterial: "cipher",
    status: "active",
  } as AccountRow
  const installed: RecoveryCapability[] = []
  const retired: string[] = []
  let issued = 0
  let committed = 0
  let catalogCalls = 0
  let acknowledgmentLost = false
  let outcomeUnavailable = false
  let catalog: () => Promise<void> = async () => {}
  const deps: RecoveryCoordinatorDeps = {
    config: {
      intervalMs: 1000,
      batchSize: 2,
      demandCapacity: 2,
      demandTtlMs: 10000,
      outcomeCapacity: 2,
      preparationLeaseMs: 1000,
      maximumOutcomeMs: 10000,
      cooldownMs: 1000,
      shutdownDrainMs: 20,
      quotaSpentThreshold: 1,
    },
    now: () => new Date(1000),
    schedule: () => () => {},
    warn: () => {},
    accounts: { findById: async () => account },
    refreshCatalogAfterMutation: async () => {
      catalogCalls++
      await catalog()
    },
    install: (cap) => {
      installed.push(cap)
      return true
    },
    retire: (_id, generation) => {
      retired.push(generation)
    },
    repository: {
      beginOperatorRecovery: async () => undefined,
      beginAutomaticRecovery: async () => row,
      cancel: async () => undefined,
      hydrateIssued: async (input) =>
        row.state === "issued" &&
        row.ownerBootId === input.ownerBootId &&
        row.lifecycleVersion === input.expected.lifecycleVersion
          ? row
          : undefined,
      listPending: async ({ accountIds }) =>
        row.state === "pending" && accountIds.includes(row.accountId) ? [row] : [],
      listExpiredIssued: async () => [],
      listIssuedForOwner: async (input) =>
        row.state === "issued" &&
        row.ownerBootId === input.ownerBootId &&
        input.accountIds.includes(row.accountId)
          ? [row]
          : [],
      assignPending: async (input) => {
        if (row.state !== "pending") return undefined
        row = { ...row, ownerBootId: input.ownerBootId, ownershipEpoch: row.ownershipEpoch + 1 }
        return row
      },
      issue: async (input) => {
        if (row.state !== "pending") return undefined
        issued++
        row = { ...row, state: "issued", permitId: input.permitId }
        if (acknowledgmentLost) {
          acknowledgmentLost = false
          throw new Error("ack lost")
        }
        return row
      },
      outcome: async (input) => {
        if (outcomeUnavailable) throw new Error("DB unavailable")
        if (row.state === "issued") {
          committed++
          row = { ...row, state: input.state }
        }
        return row
      },
      markUncertain: async () => undefined,
    },
  }
  const coordinator = createRecoveryCoordinator(deps)
  return {
    coordinator,
    installed,
    retired,
    deps,
    counts: () => ({ issued, committed, catalogCalls }),
    ackLost: () => {
      acknowledgmentLost = true
    },
    outcomeDown: (value: boolean) => {
      outcomeUnavailable = value
    },
    holdCatalog: () => {
      const held = deferred()
      catalog = () => held.promise
      return held
    },
    state: () => row,
  }
}

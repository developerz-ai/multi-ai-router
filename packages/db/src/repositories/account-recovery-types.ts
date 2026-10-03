import type { RecoveryReason, RecoveryRow } from "../schema/account-recoveries"
import type { AccountRow } from "../schema/accounts"
import type { AccountObservation } from "./account-lifecycle-types"
export type OperatorCheckView = {
  account: AccountRow
  recovery?: RecoveryRow
  retryAt: Date
  checkInProgress?: boolean
}
export interface RecoveryRepository {
  reserveOperatorCheck(input: {
    accountId: string
    claimToken: string
    leaseMs: number
  }): Promise<
    | { kind: "acquired"; account: AccountRow; claimToken: string; leaseUntil: Date }
    | (OperatorCheckView & { kind: "busy" | "cooldown" })
    | undefined
  >
  finalizeOperatorCheck(
    input: Parameters<RecoveryRepository["beginOperatorRecovery"]>[0] & {
      claimToken: string
    },
  ): Promise<
    | {
        kind: "committed"
        result: NonNullable<Awaited<ReturnType<RecoveryRepository["beginOperatorRecovery"]>>>
      }
    | (OperatorCheckView & { kind: "refused" })
    | undefined
  >
  releaseOperatorCheck(input: { accountId: string; claimToken: string }): Promise<void>

  readOperatorCooldown(accountId: string): Promise<
    | {
        account: AccountRow
        recovery: RecoveryRow
        rechecked: false
        clearedStatus: null
      }
    | undefined
  >

  beginOperatorRecovery(input: {
    accountId: string
    generationCandidate: string
    cooldownMs: number
    negativeAuthObservation?: {
      lifecycleVersion: number
      authMaterial: string | null
      loggedIn: false
    }
  }): Promise<
    | {
        account: AccountRow
        recovery: RecoveryRow
        rechecked: boolean
        clearedStatus: "exhausted" | null
      }
    | undefined
  >
  beginAutomaticRecovery(input: {
    accountId: string
    generationCandidate: string
    expected: AccountObservation
    expectedRecoveryRevision: number | null
    reason: Exclude<RecoveryReason, "operator-recheck" | "operator-enable">
    cooldownMs: number
  }): Promise<RecoveryRow | undefined>
  assignPending(input: {
    accountId: string
    generation: string
    expectedEpoch: number
    ownerBootId: string
    leaseMs: number
  }): Promise<RecoveryRow | undefined>
  issue(input: {
    accountId: string
    generation: string
    expectedEpoch: number
    ownerBootId: string
    permitId: string
    expected: AccountObservation
  }): Promise<RecoveryRow | undefined>
  hydrateIssued(input: {
    accountId: string
    generation: string
    permitId: string
    ownerBootId: string
    expectedEpoch: number
    expected: AccountObservation
    maximumOutcomeAgeMs: number
  }): Promise<RecoveryRow | undefined>
  outcome(input: {
    accountId: string
    generation: string
    permitId: string
    ownerBootId: string
    expectedEpoch: number
    expected: AccountObservation
    state: "succeeded" | "failed" | "uncertain"
    cooldownMs: number
    quotaSpentThreshold: number
  }): Promise<RecoveryRow | undefined>
  markUncertain(input: {
    accountId: string
    generation: string
    permitId: string
    maximumOutcomeAgeMs: number
  }): Promise<RecoveryRow | undefined>
  cancel(input: { accountId: string; generation: string }): Promise<RecoveryRow | undefined>
  listPending(input: { limit: number; accountIds: readonly string[] }): Promise<RecoveryRow[]>
  listIssuedForOwner(input: {
    limit: number
    ownerBootId: string
    accountIds: readonly string[]
  }): Promise<RecoveryRow[]>
  listExpiredIssued(input: { limit: number; maximumOutcomeAgeMs: number }): Promise<RecoveryRow[]>
}

import type {
  AccountObservation,
  AccountRow,
  RecoveryRepository,
  RecoveryRow,
} from "@multi-ai-router/db"

export type { RecoveryRepository, RecoveryRow }
export interface AutomaticRecoveryRequest {
  accountId: string
  expected: AccountObservation
  expectedRecoveryRevision: number | null
  reason: "authentication-recovered" | "cooldown-expired" | "quota-stale"
}
export interface RecoveryOutcome {
  accountId: string
  generation: string
  permitId: string
  ownershipEpoch: number
  expected: AccountObservation
  state: "succeeded" | "failed" | "uncertain"
}
export interface RecoveryCapability {
  readonly revision: number
  readonly accountId: string
  readonly generation: string
  readonly permitId: string
  readonly ownerBootId: string
  readonly ownershipEpoch: number
  readonly expected: AccountObservation
  readonly quotaRevisions: Readonly<Record<string, number>>
}
export interface RecoveryCoordinatorConfig {
  readonly intervalMs: number
  readonly batchSize: number
  readonly demandCapacity: number
  readonly demandTtlMs: number
  readonly outcomeCapacity: number
  readonly preparationLeaseMs: number
  readonly maximumOutcomeMs: number
  readonly cooldownMs: number
  readonly quotaSpentThreshold: number
  readonly shutdownDrainMs: number
}
export interface RecoveryCoordinatorDeps {
  readonly repository: RecoveryRepository
  readonly accounts: { findById(id: string): Promise<AccountRow | undefined> }
  readonly config: RecoveryCoordinatorConfig
  readonly now: () => Date
  readonly schedule: (work: () => void, delayMs: number) => () => void
  readonly refreshCatalogAfterMutation: () => Promise<void>
  /** Must refuse reinstalling a consumed capability; synchronous and idempotent. */
  readonly install: (capability: RecoveryCapability) => boolean
  readonly retire: (accountId: string, generation: string) => void
  readonly warn: (message: string, error?: unknown) => void
}
export interface RecoveryCoordinator {
  readonly bootId: string
  requestAutomatic(request: AutomaticRecoveryRequest): boolean
  forget(accountId: string): void
  demand(accountId: string): void
  /** False leaves caller's consumed local permit gated; never means retry a provider call. */
  recordOutcome(outcome: RecoveryOutcome): boolean
  tick(): Promise<void>
  start(): void
  stop(): Promise<void>
}

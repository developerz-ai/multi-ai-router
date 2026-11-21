import type { OwnerLaunchFactory } from "./owned-query"
import type { OwnerLaunchConfig } from "./owner-launch"
import type { ReplicaGenerationHandle } from "./replica-lease"

export interface AccountOwnershipConfig extends OwnerLaunchConfig {
  readonly cleanupMaximumEntries: number
  readonly cleanupMaximumDepth: number
  readonly operationTimeoutMs: number
  readonly shutdownDrainMs: number
  readonly generation?: (accountId: string) => ReplicaGenerationHandle
}
export interface AccountCliOwnership {
  readonly ownerLaunch: OwnerLaunchFactory
  provisionAccount(input: { id: string; configDir: string }): Promise<string>
  revokeDeletedAccount(input: { id: string; configDir: string | null }): Promise<void>
  cleanupDeletedAccount(input: {
    id: string
    configDir: string | null
  }): Promise<"removed" | "deferred" | "not_applicable">
  withMetadataOwner<T>(accountId: string, task: () => Promise<T>): Promise<T>
  retireLocalOwners?(accountId: string): Promise<void>
  drainMetadata?(accountId: string): Promise<void>
  /** Permanent revocation also invalidates credentials cached under this Account's fence. */
  isRevoked?(accountId: string): boolean
  closeAdmission(): void
  stop(): Promise<void>
}

import type { ReplicaLeaseToken } from "@multi-ai-router/db"
import type { ReplicaAttachment } from "./replica-lease"

export interface ExclusiveStorageAttachment {
  // Requires storage-enforced exclusion, not a TTL or path check.
  confirm(token: ReplicaLeaseToken, identity: string): Promise<boolean>
  retireLocalOwners(accountId: string): Promise<void>
  // Await filesystem callbacks as well as guardian exits, including expired generations.
  drainMetadata(accountId: string): Promise<void>
  // Prove absence in persistent allocation history, not merely on this disk.
  provisionNew?(token: ReplicaLeaseToken, identity: string): Promise<void>
}

export interface ReplicaStorage extends ReplicaAttachment {
  provisionNew(token: ReplicaLeaseToken): Promise<void>
}

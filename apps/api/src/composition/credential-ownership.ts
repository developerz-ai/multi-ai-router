import { basename, join } from "node:path"
import type { FastCredentialCache } from "../providers/claude-fast/credential-cache"
import type { AccountCliOwnership } from "../providers/claude-sdk/account-ownership"
import type { CredentialMetadataReader } from "../providers/claude-sdk/credential-metadata"
import { CredentialOwnerLaunchFailed } from "../providers/claude-sdk/owner-helper"
import { CredentialMetadataOwnershipUnavailable } from "../providers/claude-sdk/ownership-errors"
import type { ReplicaLeaseManager } from "../providers/claude-sdk/replica-lease"
import { UpstreamAdmissionRefused } from "../providers/upstream-admission"

/** Validate both sides of the asynchronous lookup, including cache hits. */
export function generationOwnedCredentials(
  cache: FastCredentialCache,
  leases: Pick<ReplicaLeaseManager, "handle">,
): FastCredentialCache {
  const generations = new Map<string, bigint>()
  return {
    forget(id) {
      generations.delete(id)
      cache.forget(id)
    },
    async read(id, path) {
      try {
        const handle = leases.handle(id)
        handle.assert()
        if (generations.get(id) !== handle.generation) cache.forget(id)
        generations.set(id, handle.generation)
        const value = await cache.read(id, path)
        handle.assert()
        return value
      } catch (error) {
        generations.delete(id)
        cache.forget(id)
        throw error
      }
    },
  }
}

export function ownedCredentialMetadataReader(
  reader: CredentialMetadataReader,
  owners: AccountCliOwnership,
  root: string,
): CredentialMetadataReader {
  return {
    read: async (path) => {
      const id = basename(path)
      if (path !== join(root, id))
        return Promise.reject(new Error("credential directory authority mismatch"))
      try {
        return await owners.withMetadataOwner(id, () => reader.read(path))
      } catch (error) {
        // Filesystem admission failure is preparation failure, not account quota refusal.
        if (error instanceof UpstreamAdmissionRefused)
          throw new CredentialMetadataOwnershipUnavailable(
            error.cause instanceof CredentialOwnerLaunchFailed ? error.cause : undefined,
          )
        throw error
      }
    },
  }
}

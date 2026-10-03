import { basename, join } from "node:path"
import type { AccountCliOwnership } from "../providers/claude-sdk/account-ownership"
import type { CredentialMetadataReader } from "../providers/claude-sdk/credential-metadata"
import { CredentialMetadataOwnershipUnavailable } from "../providers/claude-sdk/ownership-errors"
import { UpstreamAdmissionRefused } from "../providers/upstream-admission"

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
          throw new CredentialMetadataOwnershipUnavailable()
        throw error
      }
    },
  }
}

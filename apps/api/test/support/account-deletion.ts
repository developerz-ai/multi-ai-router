import type { AccountConfigDirs } from "../../src/providers/claude-sdk/config-dir"

/** Isolated CRUD fixtures have no subprocess owners; lifecycle tests supply real owner doubles. */
export function accountDeletionFixture(dirs: AccountConfigDirs) {
  return {
    revokeDeletedAccount: async () => {},
    deletionCommitted: async () => {},
    cleanupDeletedAccount: async ({ id, configDir }: { id: string; configDir: string | null }) => {
      if (configDir === null) return "not_applicable" as const
      await dirs.remove(id)
      return "removed" as const
    },
  }
}

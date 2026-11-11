import type { useQueryClient } from "@tanstack/solid-query"
import { queryKeys } from "./query-keys"

/**
 * Everything that reads an account, refetched after any account write or login.
 *
 * Pools carry each member's label, provider and status, so they go stale with the account. Every
 * write routed through here is audited, and without the audit root the log would only update on a
 * reload — which reads as a write that was not recorded.
 */
export async function invalidateAccountReaders(
  client: ReturnType<typeof useQueryClient>,
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.accounts.root() }),
    client.invalidateQueries({ queryKey: queryKeys.pools.root() }),
    client.invalidateQueries({ queryKey: queryKeys.audit.root() }),
  ])
}

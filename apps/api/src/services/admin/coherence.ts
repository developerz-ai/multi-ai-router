import type { AccountsService } from "../accounts"
import type { KeyMutationKind } from "../keys"
import type { AdminResult } from "./result"

/**
 * Keeps the request path's warm state honest after an admin write.
 *
 * The data plane reads two in-memory caches — the routing catalog and the
 * verified-key cache — because CLAUDE.md non-negotiable 8 forbids a query on the
 * critical path. That is a correctness debt at every write: an account disabled
 * in the console still routes, and a revoked key still authenticates, until the
 * cache expires.
 *
 * Committed-mutation callbacks pay it at the moment of the write. Account and
 * key services await those callbacks before audit or response mapping, so a
 * committed change cannot remain locally cached if subsequent work fails.
 * The compatibility account decorator below observes successful returned results;
 * production account CRUD instead uses its earlier committed callback.
 *
 * A hook runs **only on success**. A rejected write changed nothing, so
 * refreshing after it would be a query bought for no reason — and on the failure
 * path those add up, since a misconfigured console can retry hard.
 *
 * The hook is awaited before the response is written. That is what makes the
 * console read-after-write consistent, and it is affordable precisely because
 * this is the admin plane: no latency budget applies here, and the alternative —
 * returning 201 for an account the very next request cannot route to — is the
 * kind of bug an operator debugs for an hour.
 */

export interface CoherenceHooks {
  /** Re-reads the warm routing catalog. */
  readonly refreshCatalog: () => Promise<void>
  /** Drops one key from the verification cache. */
  readonly invalidateKey: (keyId: string) => void
  /** Drops authorization and rate-limit state after revocation or deletion. */
  readonly forgetKey: (keyId: string) => void
}

/** Runs `after` when the result succeeded, then returns the result untouched. */
async function onSuccess<T>(
  result: AdminResult<T>,
  after: (value: T) => void | Promise<void>,
): Promise<AdminResult<T>> {
  if (result.ok) await after(result.value)
  return result
}

/**
 * Every account mutation changes what routing may select — status, weight,
 * priority, alias map, or the account's existence — so all four refresh.
 */
export function withCatalogRefresh(
  service: AccountsService,
  hooks: Pick<CoherenceHooks, "refreshCatalog">,
): AccountsService {
  return {
    list: (query) => service.list(query),
    get: (id) => service.get(id),
    create: async (body) => onSuccess(await service.create(body), hooks.refreshCatalog),
    update: async (id, body) => onSuccess(await service.update(id, body), hooks.refreshCatalog),
    disable: async (id) => onSuccess(await service.disable(id), hooks.refreshCatalog),
    remove: async (id) => onSuccess(await service.remove(id), hooks.refreshCatalog),
  }
}

/** Runs immediately after a committed key mutation, before response mapping or other work. */
export function keyMutationCommitted(
  hooks: Pick<CoherenceHooks, "invalidateKey" | "forgetKey">,
  keyId: string,
  kind: KeyMutationKind,
): void {
  if (kind === "update") hooks.invalidateKey(keyId)
  else if (kind === "revoke" || kind === "remove") hooks.forgetKey(keyId)
}

import type { AccountsService } from "../accounts"
import type { KeysService } from "../keys"
import type { PoolsService } from "../pools"
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
 * These decorators pay it at the moment of the write. They are **decorators and
 * not service dependencies** deliberately: cache coherence is not the accounts
 * service's reason to change, and a service that knew about the catalog could no
 * longer be tested without one. Each service stays a pure CRUD unit; this file
 * is the only thing that knows a cache exists.
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

/** Pool membership, policy, and the overflow account are all read from the catalog. */
export function withPoolCatalogRefresh(
  service: PoolsService,
  hooks: Pick<CoherenceHooks, "refreshCatalog">,
): PoolsService {
  return {
    list: () => service.list(),
    get: (id) => service.get(id),
    create: async (body) => onSuccess(await service.create(body), hooks.refreshCatalog),
    update: async (id, body) => onSuccess(await service.update(id, body), hooks.refreshCatalog),
    remove: async (id) => onSuccess(await service.remove(id), hooks.refreshCatalog),
  }
}

/**
 * Key writes invalidate that key's cache entry and nothing else.
 *
 * `revoke` and `remove` are the two that must not wait for a TTL — a withdrawal
 * of access that takes effect in sixty seconds is not a withdrawal. `update` is
 * included because it can narrow a scope, which is the same thing by degrees.
 * `create` is absent on purpose: a key that does not exist yet cannot be cached,
 * and the negative-cache TTL is short precisely so a freshly minted key starts
 * working without one.
 *
 * Invalidation is by id, so it is applied to the id in the request rather than
 * to the returned view — `remove` returns a receipt, not a key.
 */
export function withKeyInvalidation(
  service: KeysService,
  hooks: Pick<CoherenceHooks, "invalidateKey">,
): KeysService {
  return {
    list: () => service.list(),
    get: (id) => service.get(id),
    create: (body) => service.create(body),
    reveal: (id) => service.reveal(id),
    update: async (id, body) =>
      onSuccess(await service.update(id, body), () => hooks.invalidateKey(id)),
    revoke: async (id) => onSuccess(await service.revoke(id), () => hooks.invalidateKey(id)),
    remove: async (id) => onSuccess(await service.remove(id), () => hooks.invalidateKey(id)),
  }
}

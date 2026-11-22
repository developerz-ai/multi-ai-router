import type { PendingClaudeLoginRepository, PendingClaudeLoginToken } from "@multi-ai-router/db"
import type { AdminResult } from "../../admin/result"
import type { ClaudeConnectDeps } from "./claude-types"

export type ClaimStore = Pick<PendingClaudeLoginRepository, "claim" | "find" | "clear">

/** A deployment with no shared claim repository: local pending state is the whole claim surface. */
export function createClaimStore(deps: ClaudeConnectDeps): ClaimStore {
  const none: ClaimStore = {
    claim: async () => true,
    find: async () => undefined,
    clear: async () => true,
  }
  return deps.claims ?? none
}

export const PASTE_ON_OWNER =
  "another instance owns this login — paste on that instance or start a new login"

/** A paste from a replica that no longer owns the claim or the account lease is refused. */
export async function refuseForeignPaste(
  deps: ClaudeConnectDeps,
  accountId: string,
  claims: ClaimStore,
  ownerOf: () => string,
  token: (accountId: string) => PendingClaudeLoginToken | undefined,
  foreignOwner: (accountId: string, message: string) => AdminResult<never>,
): Promise<AdminResult<never> | undefined> {
  const claim = await claims.find(accountId)
  if (claim !== undefined && deps.claims !== undefined && ownerOf() !== claim.owner)
    return foreignOwner(accountId, PASTE_ON_OWNER)
  const tokenNow = token(accountId)
  if (deps.leaseToken !== undefined && tokenNow === undefined)
    return foreignOwner(
      accountId,
      "start the login on the instance that owns this account, then paste the code on that instance or start a new login",
    )
  const changed =
    (claim !== undefined && tokenNow !== undefined && tokenNow.generation !== claim.generation) ||
    (claim !== undefined && tokenNow !== undefined && tokenNow.owner !== claim.owner) ||
    (claim !== undefined && claim.accountId !== accountId)
  if (!changed) return undefined
  if (claim !== undefined && tokenNow !== undefined && ownerOf() !== claim.owner)
    return foreignOwner(accountId, PASTE_ON_OWNER)
  return foreignOwner(accountId, "the account lease changed during the login — start again")
}

export function createLeaseFence(deps: ClaudeConnectDeps) {
  // A replica with no lease source is a single-local deployment: it owns every account.
  const localOwner = (): string => deps.owner?.() ?? "local"
  const ownerOf = (): string => deps.leaseToken?.("")?.owner ?? localOwner()
  const token = (accountId: string): PendingClaudeLoginToken | undefined => {
    const lease = deps.leaseToken?.(accountId)
    // A configured lease source that returns nothing is a replica without a live lease, not a
    // single-local deployment. It must not invent a token and claim the account.
    if (deps.leaseToken !== undefined && lease === undefined) return undefined
    return { accountId, owner: lease?.owner ?? localOwner(), generation: lease?.generation ?? 0n }
  }
  return { localOwner, ownerOf, token }
}

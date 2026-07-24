import type { AccountStatus, ProviderId, RoutingPolicy } from "@multi-ai-router/core"
import type { AccountRow, PoolMemberRow, PoolRow } from "@multi-ai-router/db"

/**
 * What the console renders for a pool.
 *
 * Members carry their account's label, provider, and status alongside the
 * membership's own weight and priority, because the operator's question is
 * "which accounts are in this pool and are they up" — answering it should not
 * cost the SPA a second round trip per member. Nothing here touches credential
 * material: `AccountRow.authMaterial` is never read.
 */
export interface PoolMemberView {
  readonly accountId: string
  readonly label: string
  readonly provider: ProviderId
  readonly status: AccountStatus
  /** The membership's own weight, which overrides the account's for this pool. */
  readonly weight: number
  readonly priority: number
}

export interface PoolView {
  readonly id: string
  readonly name: string
  readonly policy: RoutingPolicy
  readonly overflowAccountId: string | null
  readonly members: readonly PoolMemberView[]
  readonly createdAt: string
  readonly updatedAt: string
}

export function toPoolView(
  pool: PoolRow,
  members: readonly PoolMemberRow[],
  accounts: ReadonlyMap<string, AccountRow>,
): PoolView {
  return {
    id: pool.id,
    name: pool.name,
    policy: pool.policy,
    overflowAccountId: pool.overflowAccountId,
    members: members.flatMap((member) =>
      member.poolId === pool.id ? toMemberView(member, accounts.get(member.accountId)) : [],
    ),
    createdAt: pool.createdAt.toISOString(),
    updatedAt: pool.updatedAt.toISOString(),
  }
}

/**
 * `pool_members.account_id` is `ON DELETE CASCADE`, so a membership without its
 * account cannot exist. If one ever does, the pool is rendered without it rather
 * than with an invented label — a fabricated provider on a fabricated row is
 * worse than a missing one.
 */
function toMemberView(member: PoolMemberRow, account: AccountRow | undefined): PoolMemberView[] {
  if (account === undefined) return []
  return [
    {
      accountId: member.accountId,
      label: account.label,
      provider: account.provider,
      status: account.status,
      weight: member.weight,
      priority: member.priority,
    },
  ]
}

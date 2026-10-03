import { DEFAULT_ACCOUNT_PRIORITY, DEFAULT_ACCOUNT_WEIGHT } from "@multi-ai-router/core"
import type { AccountRow, PoolMemberInput, PoolMemberRow } from "@multi-ai-router/db"
import { type AdminResult, invalid, ok } from "../admin/result"
import type { PoolMemberInputBody } from "./schemas"

interface ReferenceCheck {
  /** The membership the write carries, or `undefined` when it leaves the set alone. */
  readonly members: readonly PoolMemberInputBody[] | undefined
  /** The membership the pool will hold once the write lands. */
  readonly memberIds: ReadonlySet<string>
  /** The overflow the pool will hold once the write lands. */
  readonly overflowAccountId: string | null
  readonly accounts: ReadonlyMap<string, AccountRow>
}

/**
 * Membership and overflow must both name real accounts, a member may appear
 * once, and the overflow must be one of the members.
 */
export function checkReferences(check: ReferenceCheck): AdminResult<null> {
  const { members, memberIds, overflowAccountId, accounts } = check

  if (members !== undefined) {
    const seen = new Set<string>()
    const unknown: string[] = []
    for (const member of members) {
      if (seen.has(member.accountId)) {
        return invalid(
          `account "${member.accountId}" is listed twice: a pool holds one membership per account`,
          "duplicate_member",
        )
      }
      seen.add(member.accountId)
      if (!accounts.has(member.accountId)) unknown.push(member.accountId)
    }
    if (unknown.length > 0) {
      return invalid(
        `no account with id ${unknown.map((id) => `"${id}"`).join(", ")}`,
        "unknown_account",
      )
    }
  }

  if (overflowAccountId === null) return ok(null)

  if (!accounts.has(overflowAccountId)) {
    return invalid(
      `overflow account "${overflowAccountId}" does not exist`,
      "unknown_overflow_account",
    )
  }

  if (!memberIds.has(overflowAccountId)) {
    return invalid(
      `overflow account "${overflowAccountId}" is not a member of this pool. The overflow is a ` +
        `member held back from the policy, not a way out of the pool: a key scoped to this pool ` +
        `must never reach an account the pool does not hold. Add it as a member, or clear the ` +
        `overflow.`,
      "overflow_not_member",
    )
  }

  return ok(null)
}

export function idsOf(members: readonly { readonly accountId: string }[]): ReadonlySet<string> {
  return new Set(members.map((member) => member.accountId))
}

/**
 * Fills in what the write left unsaid, so `replaceMembers` is handed a fully
 * stated membership and the column defaults never decide routing.
 *
 * Precedence is: the number the body sent → the number this membership already
 * carries → the account's own. The middle step is the one that keeps a rename
 * from re-flattening a `weighted` pool, and the last is what makes "absent
 * inherits the account's own" (`schemas.ts`) true for a member being added.
 */
export function resolveTuning(
  accounts: ReadonlyMap<string, AccountRow>,
  held: readonly PoolMemberRow[],
): (member: PoolMemberInputBody) => PoolMemberInput {
  const current = new Map(held.map((member) => [member.accountId, member]))
  return (member) => {
    const membership = current.get(member.accountId)
    const account = accounts.get(member.accountId)
    return {
      accountId: member.accountId,
      weight: member.weight ?? membership?.weight ?? account?.weight ?? DEFAULT_ACCOUNT_WEIGHT,
      priority:
        member.priority ?? membership?.priority ?? account?.priority ?? DEFAULT_ACCOUNT_PRIORITY,
    }
  }
}

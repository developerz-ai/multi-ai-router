import type { PoolRoster } from "../../config/pool-roster"

/**
 * Desired-versus-live pool roster drift, as a pure function.
 *
 * The roster (`POOL_ROSTER_PATH`, `config/pool-roster.ts`) is the declarative side: pools, each
 * naming its members and its overflow **by account label**. The live side is the database: pools by
 * id with their `pool_members`, and the accounts that turn a label into an id. Folding the two is
 * the whole check, so it lives here with no clock, no store and no I/O — the task that owns it
 * (`pool-roster-check.ts`) only reads and reports (CLAUDE.md rule 9).
 *
 * **A live pool the roster does not name is not drift.** The roster governs the pools it lists;
 * an operator's ad-hoc pool is configuration, not a discrepancy to alert on. Reporting it would
 * make the roster mandatory for every pool that ever exists.
 *
 * **Overflow is checked in three parts**, because the schema's rule (docs/idea/05-routing-and-
 * failover.md#overflow-optional-opt-in) is that the overflow must be one of the pool's own
 * members: nothing configured is `no_overflow`, a configured overflow that the membership does not
 * hold is `overflow_mismatch` (a state `services/pools` refuses to write but a cascaded account
 * deletion can still produce), and an overflow that is a member but not the one the roster names is
 * `overflow_mismatch` too.
 */

export type RosterDriftKind =
  | "pool_missing"
  | "missing_member"
  | "unexpected_member"
  | "no_overflow"
  | "overflow_mismatch"

export interface RosterDriftItem {
  readonly kind: RosterDriftKind
  /** The roster's name for the pool — the only pool identity when the pool is absent live. */
  readonly poolName: string
  /** The live pool, or `null` for `pool_missing`. */
  readonly poolId: string | null
  /** The label naming the account: the roster's when the account is missing, live otherwise. */
  readonly accountLabel: string | null
  /** The live account id, or `null` where no live account answers that label. */
  readonly accountId: string | null
}

/** One live account, as far as a roster label needs it. */
export interface LiveRosterAccount {
  readonly id: string
  readonly label: string
}

/** One live pool with the membership `pool_members` holds and the overflow `pools` records. */
export interface LiveRosterPool {
  readonly id: string
  readonly name: string
  readonly memberIds: readonly string[]
  readonly overflowAccountId: string | null
}

export interface LiveRoster {
  readonly pools: readonly LiveRosterPool[]
  readonly accounts: readonly LiveRosterAccount[]
}

/** Kinds in the order a pool's items are reported, so two runs over one fixture are comparable. */
const KIND_ORDER: Readonly<Record<RosterDriftKind, number>> = {
  pool_missing: 0,
  missing_member: 1,
  unexpected_member: 2,
  no_overflow: 3,
  overflow_mismatch: 4,
}

export function diffRoster(
  roster: Pick<PoolRoster, "pools">,
  live: LiveRoster,
): readonly RosterDriftItem[] {
  const accountsByLabel = new Map<string, LiveRosterAccount>()
  const accountsById = new Map<string, LiveRosterAccount>()
  for (const account of live.accounts) {
    accountsById.set(account.id, account)
    // Labels are not unique in the schema: the first account holding one is the one a roster names,
    // and a pool whose membership misses it reports the drift either way.
    if (!accountsByLabel.has(account.label)) accountsByLabel.set(account.label, account)
  }
  const poolsByName = new Map(live.pools.map((pool) => [pool.name, pool]))

  const items: RosterDriftItem[] = []
  for (const desired of roster.pools) {
    const held = poolsByName.get(desired.name)
    if (held === undefined) {
      items.push({
        kind: "pool_missing",
        poolName: desired.name,
        poolId: null,
        accountLabel: null,
        accountId: null,
      })
      continue
    }

    const members = new Set(held.memberIds)
    const desiredIds = new Set<string>()
    for (const label of desired.members) {
      const account = accountsByLabel.get(label)
      if (account === undefined) {
        items.push(missing(desired.name, held.id, label, null))
        continue
      }
      desiredIds.add(account.id)
      if (!members.has(account.id)) items.push(missing(desired.name, held.id, label, account.id))
    }

    for (const accountId of held.memberIds) {
      if (desiredIds.has(accountId)) continue
      items.push({
        kind: "unexpected_member",
        poolName: desired.name,
        poolId: held.id,
        accountLabel: accountsById.get(accountId)?.label ?? null,
        accountId,
      })
    }

    items.push(...overflowDrift(desired, held, accountsById))
  }

  return items.sort(
    (left, right) =>
      left.poolName.localeCompare(right.poolName) ||
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      (left.accountLabel ?? "").localeCompare(right.accountLabel ?? "") ||
      (left.accountId ?? "").localeCompare(right.accountId ?? ""),
  )
}

function missing(
  poolName: string,
  poolId: string,
  accountLabel: string,
  accountId: string | null,
): RosterDriftItem {
  return { kind: "missing_member", poolName, poolId, accountLabel, accountId }
}

function overflowDrift(
  desired: PoolRoster["pools"][number],
  held: LiveRosterPool,
  accountsById: ReadonlyMap<string, LiveRosterAccount>,
): readonly RosterDriftItem[] {
  const base = { poolName: desired.name, poolId: held.id } as const
  if (held.overflowAccountId === null) {
    // Nothing configured: the roster names an overflow and the pool engages none, so every member
    // filters out with no fallback and the pool serves nothing until a request re-tests it.
    return [{ ...base, kind: "no_overflow", accountLabel: desired.overflow, accountId: null }]
  }
  // The schema forbids this shape, but `ON DELETE SET NULL` on the account is not the only way a
  // membership can vanish: a mid-transaction membership replace leaves it briefly, and a restore
  // can leave it for good.
  if (!held.memberIds.includes(held.overflowAccountId)) {
    return [
      {
        ...base,
        kind: "overflow_mismatch",
        accountLabel: accountsById.get(held.overflowAccountId)?.label ?? desired.overflow,
        accountId: held.overflowAccountId,
      },
    ]
  }
  const liveLabel = accountsById.get(held.overflowAccountId)?.label ?? null
  if (liveLabel === desired.overflow) return []
  // A different member is engaged: the item names the account that *is* the overflow, because that
  // is the row an operator has to change — the roster already says which one it wants.
  return [
    {
      ...base,
      kind: "overflow_mismatch",
      accountLabel: liveLabel,
      accountId: held.overflowAccountId,
    },
  ]
}

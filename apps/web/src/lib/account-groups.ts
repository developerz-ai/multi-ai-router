import type { AccountStatus } from "@multi-ai-router/core"
import { isRoutableNow, needsOperator, STATUS_DISPLAY_ORDER } from "./account-status"
import type { AccountView, PoolView } from "./api/types"
import { providerDisplayName } from "./provider-display"
import { describeLoginExpiry, isSubscriptionLogin } from "./subscription-login"

// The accounts page, grouped. Pure: accounts and a clock in, ordered sections out.
//
// Pooling is the product — six Claude subscriptions side by side is the normal fleet — so the
// list is read per provider, and the providers are ordered by what the operator has to *do*:
// the group with an account no clock will fix comes first, then the biggest fleet.

export interface ProviderGroup {
  readonly provider: string
  readonly name: string
  readonly accounts: readonly AccountView[]
  /** Routable *right now* — status allows it and no quota window is spent. */
  readonly routable: number
  /** How many need a human: `exhausted`, `needs_reauth`, or a subscription login that is gone. */
  readonly attention: number
  /** The least healthy status in the group, in lifecycle order (`active` … `disabled`). */
  readonly worst: AccountStatus
  /** Soonest subscription-login expiry among still-valid logins, epoch ms. Null where none. */
  readonly nextLoginExpiryMs: number | null
  /** Subscription accounts whose login is gone — the queue "Reconnect all" walks. */
  readonly reconnectable: readonly AccountView[]
}

/**
 * The pools any of these accounts belongs to, by name, in the pools' own order. The accounts
 * read carries no membership — the pools read does — so the join is made here, once, from the
 * two lists the page already holds.
 */
export function poolNamesFor(
  pools: readonly PoolView[],
  accounts: readonly Pick<AccountView, "id">[],
): readonly string[] {
  const ids = new Set(accounts.map((account) => account.id))
  return pools
    .filter((pool) => pool.members.some((member) => ids.has(member.accountId)))
    .map((pool) => pool.name)
}

export function groupAccountsByProvider(
  accounts: readonly AccountView[],
  nowMs: number,
): readonly ProviderGroup[] {
  const byProvider = new Map<string, AccountView[]>()
  for (const account of accounts) {
    const bucket = byProvider.get(account.provider)
    if (bucket === undefined) byProvider.set(account.provider, [account])
    else bucket.push(account)
  }

  return [...byProvider.entries()]
    .map(([provider, members]) => describeGroup(provider, members, nowMs))
    .sort(compareGroups)
}

function describeGroup(
  provider: string,
  members: readonly AccountView[],
  nowMs: number,
): ProviderGroup {
  let nextLoginExpiryMs: number | null = null
  const reconnectable: AccountView[] = []
  let attention = 0

  for (const account of members) {
    if (needsOperator(account.status)) attention += 1
    if (!isSubscriptionLogin(account) || account.status === "disabled") continue
    const login = describeLoginExpiry(account, nowMs)
    if (login.kind === "expired") {
      reconnectable.push(account)
      // Counted once: a `needs_reauth` subscription is already in `attention`.
      if (!needsOperator(account.status)) attention += 1
    } else if (login.expiresAtMs !== null) {
      nextLoginExpiryMs =
        nextLoginExpiryMs === null
          ? login.expiresAtMs
          : Math.min(nextLoginExpiryMs, login.expiresAtMs)
    }
  }

  return {
    provider,
    name: providerDisplayName(provider),
    accounts: [...members].sort(compareAccounts),
    routable: members.filter((account) =>
      isRoutableNow(account.status, account.availability?.quotaWindows),
    ).length,
    attention,
    worst: worstStatus(members),
    nextLoginExpiryMs,
    reconnectable,
  }
}

/** Problems first, then the bigger fleet, then a stable name order so the page does not reshuffle. */
function compareGroups(a: ProviderGroup, b: ProviderGroup): number {
  if (a.attention > 0 !== b.attention > 0) return a.attention > 0 ? -1 : 1
  if (a.accounts.length !== b.accounts.length) return b.accounts.length - a.accounts.length
  return a.name.localeCompare(b.name)
}

/** Within a group: priority, then label — the order a priority-failover pool reads them in. */
function compareAccounts(a: AccountView, b: AccountView): number {
  if (a.priority !== b.priority) return a.priority - b.priority
  return a.label.localeCompare(b.label)
}

const STATUS_RANK: ReadonlyMap<AccountStatus, number> = new Map(
  STATUS_DISPLAY_ORDER.map((status, index) => [status, index]),
)

/**
 * Lifecycle order, not severity: `disabled` ranks last because the operator chose it, and a
 * group of switched-off accounts is not a group in trouble.
 */
function worstStatus(members: readonly AccountView[]): AccountStatus {
  let worst: AccountStatus = "active"
  let worstRank = -1
  for (const account of members) {
    if (account.status === "disabled") continue
    const rank = STATUS_RANK.get(account.status) ?? 0
    if (rank > worstRank) {
      worst = account.status
      worstRank = rank
    }
  }
  return worstRank === -1 && members.length > 0 ? "disabled" : worst
}

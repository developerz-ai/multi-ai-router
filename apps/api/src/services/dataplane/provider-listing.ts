import {
  type AccountStatus,
  isStandingBlock,
  type ProviderId,
  type QuotaWindowKind,
  type ResetSource,
} from "@multi-ai-router/core"
import { type AccountSnapshot, findSpentWindow, resolveScope } from "../routing"
import type { VerifiedKey } from "./auth/verifier"
import type { CatalogListingDeps } from "./catalog-listing"
import { buildSnapshot } from "./snapshot"

/**
 * The providers behind `GET /v1/providers`: which upstreams the presenting key can actually reach,
 * and how deep the pool is behind each.
 *
 * Not the provider *registry* — that is `GET /api/admin/providers`, an admin question about what
 * this build can talk to. This is a data-plane question about what this key can reach right now,
 * so a provider with no in-scope account simply is not here, and one whose accounts are all
 * `exhausted` is here with `available: 0`. The difference is the whole point: the second is a
 * provider to top up, the first is one that was never configured.
 */
export interface CatalogProvider {
  readonly id: ProviderId
  /** In-scope accounts of this provider, whatever their status. Not liveness — see the counts. */
  readonly accounts: number
  /**
   * How many of them could serve a request now. Zero with a non-zero `accounts` is the state worth
   * seeing — the credentials exist and none of them can be used.
   */
  readonly available: number
  /**
   * The same in-scope accounts split by **live** status — the health-overlaid one routing reads, so
   * an account the breaker cooled thirty seconds ago counts as `cooling_down` here too. Every status
   * is always present (zero when none), and the five sum to `accounts`. A capacity reader sizes from
   * `active`; `cooling_down` is a clock, `exhausted` a top-up, `needs_reauth` a re-login.
   */
  readonly statuses: StatusCounts
  /**
   * One entry per in-scope account the router is holding out on a clock — a breaker cooldown or a
   * spent quota window — with the instant it expects to let it back, soonest first. No account id
   * or label: a key-holder learns "the router holds one of these until T", which is what it needs to
   * tell its own users, and nothing about credentials it cannot see. `[]` when none is held.
   */
  readonly cooling: readonly CoolingAccount[]
}

/** Why and until when the router holds one account out. */
export interface CoolingAccount {
  /** `null` when the router holds it with no stated instant (it is re-checked on a timer). */
  readonly until: Date | null
  readonly reason: "cooling-down" | "credential-rejected" | "quota-window-spent"
  /** The spent window, for `quota-window-spent`. */
  readonly window?: QuotaWindowKind
  readonly resetSource: ResetSource | null
}

export type StatusCounts = Readonly<Record<AccountStatus, number>>

/** One in-scope account as the counter sees it: whose it is and what it can do right now. */
export interface ProviderAccountStatus {
  readonly provider: ProviderId
  readonly status: AccountStatus
  readonly cooling?: CoolingAccount
}

export function providerListing(
  deps: Pick<CatalogListingDeps, "catalog" | "health">,
  key: VerifiedKey,
  now: Date,
): readonly CatalogProvider[] {
  const snapshot = buildSnapshot(deps.catalog, deps.health, now)
  const { diagnostics } = resolveScope(snapshot, { sessionKey: "", model: "", keyScope: key.scope })
  const inScope = new Set(diagnostics.inScopeAccountIds)
  const live = new Map(snapshot.accounts.map((account) => [account.id, account]))

  return countProviders(
    deps.catalog
      .accounts()
      .filter((account) => inScope.has(account.id))
      .map((account) => {
        const current = live.get(account.id)
        const status = current?.status ?? account.snapshot.status
        const cooling = current === undefined ? undefined : coolingOf(current, now)
        return {
          provider: account.driver.provider,
          status,
          ...(cooling === undefined ? {} : { cooling }),
        }
      }),
  )
}

/**
 * The clock this account is held on, read from the same live snapshot routing filters on. A
 * standing block (`exhausted`, `needs_reauth`, `disabled`) is no clock and is counted, not listed.
 * A spent window outranks the breaker: it is the provider's own account of when the quota returns.
 */
export function coolingOf(account: AccountSnapshot, now: Date): CoolingAccount | undefined {
  if (isStandingBlock(account.status)) return undefined
  const spent = findSpentWindow(account, now)
  if (spent !== null)
    return {
      until: spent.resetsAt ?? null,
      reason: "quota-window-spent",
      window: spent.window,
      resetSource: spent.resetSource ?? null,
    }
  const { cooldownUntil, cooldownReason, cooldownSource } = account.health
  // A passed instant is a half-open probe routing admits (`routing/filter.ts`), not a hold. Only a
  // `cooling_down` row with no instant at all is held with no stated end.
  if (cooldownUntil === undefined) {
    if (account.status !== "cooling_down") return undefined
    return { until: null, reason: cooldownReason ?? "cooling-down", resetSource: null }
  }
  if (cooldownUntil.getTime() <= now.getTime()) return undefined
  return {
    until: cooldownUntil,
    reason: cooldownReason ?? "cooling-down",
    resetSource: cooldownSource ?? null,
  }
}

/** Fold in-scope accounts into one row per provider, sorted by id. Pure. */
export function countProviders(
  accounts: readonly ProviderAccountStatus[],
): readonly CatalogProvider[] {
  const rows = new Map<
    ProviderId,
    { accounts: number; available: number; statuses: Counts; cooling: CoolingAccount[] }
  >()
  for (const { provider, status, cooling } of accounts) {
    const row = rows.get(provider) ?? {
      accounts: 0,
      available: 0,
      statuses: zeroCounts(),
      cooling: [],
    }
    if (cooling !== undefined) row.cooling.push(cooling)
    row.accounts += 1
    // `cooling_down` counts as available for the same reason it stays in the model catalog: a clock
    // clears it, and a provider that vanished for the length of a cooldown would read as removed.
    if (!isStandingBlock(status)) row.available += 1
    row.statuses[status] += 1
    rows.set(provider, row)
  }

  return [...rows]
    .map(([id, row]) => ({ id, ...row, cooling: row.cooling.sort(soonestFirst) }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

type Counts = Record<AccountStatus, number>

/** Known instants first, soonest first; held-with-no-instant last. */
function soonestFirst(left: CoolingAccount, right: CoolingAccount): number {
  return (
    (left.until?.getTime() ?? Number.POSITIVE_INFINITY) -
    (right.until?.getTime() ?? Number.POSITIVE_INFINITY)
  )
}

/** A literal rather than a fold over the enum: a new status fails the typecheck here, not silently. */
function zeroCounts(): Counts {
  return { active: 0, disabled: 0, cooling_down: 0, exhausted: 0, needs_reauth: 0 }
}

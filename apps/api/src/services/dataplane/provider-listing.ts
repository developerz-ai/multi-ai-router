import { type AccountStatus, isStandingBlock, type ProviderId } from "@multi-ai-router/core"
import { resolveScope } from "../routing"
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
}

export type StatusCounts = Readonly<Record<AccountStatus, number>>

/** One in-scope account as the counter sees it: whose it is and what it can do right now. */
export interface ProviderAccountStatus {
  readonly provider: ProviderId
  readonly status: AccountStatus
}

export function providerListing(
  deps: Pick<CatalogListingDeps, "catalog" | "health">,
  key: VerifiedKey,
  now: Date,
): readonly CatalogProvider[] {
  const snapshot = buildSnapshot(deps.catalog, deps.health, now)
  const { diagnostics } = resolveScope(snapshot, { sessionKey: "", model: "", keyScope: key.scope })
  const inScope = new Set(diagnostics.inScopeAccountIds)
  const liveStatus = new Map(snapshot.accounts.map((account) => [account.id, account.status]))

  return countProviders(
    deps.catalog
      .accounts()
      .filter((account) => inScope.has(account.id))
      .map((account) => ({
        provider: account.driver.provider,
        status: liveStatus.get(account.id) ?? account.snapshot.status,
      })),
  )
}

/** Fold in-scope accounts into one row per provider, sorted by id. Pure. */
export function countProviders(
  accounts: readonly ProviderAccountStatus[],
): readonly CatalogProvider[] {
  const rows = new Map<ProviderId, { accounts: number; available: number; statuses: Counts }>()
  for (const { provider, status } of accounts) {
    const row = rows.get(provider) ?? { accounts: 0, available: 0, statuses: zeroCounts() }
    row.accounts += 1
    // `cooling_down` counts as available for the same reason it stays in the model catalog: a clock
    // clears it, and a provider that vanished for the length of a cooldown would read as removed.
    if (!isStandingBlock(status)) row.available += 1
    row.statuses[status] += 1
    rows.set(provider, row)
  }

  return [...rows]
    .map(([id, row]) => ({ id, ...row }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

type Counts = Record<AccountStatus, number>

/** A literal rather than a fold over the enum: a new status fails the typecheck here, not silently. */
function zeroCounts(): Counts {
  return { active: 0, disabled: 0, cooling_down: 0, exhausted: 0, needs_reauth: 0 }
}

import type { AccountRow, ModelCatalogRepository } from "@multi-ai-router/db"
import { describeProvider } from "../accounts/providers"
import { catalogEntry } from "./entries"
import { listUpstreamModels, type UpstreamListingDeps } from "./listing"

/**
 * Refresh one Account's catalog. The unit the hourly sweep repeats and the whole of what it does.
 *
 * A service rather than logic inside the task, for the reason every other sweep here is built that
 * way: the task owns the *loop* — batching, abort, tallying, the run record — and this owns the
 * work, so the interesting half is testable without a scheduler and the scheduler is testable
 * without a provider.
 */

export interface CatalogRefreshDeps extends UpstreamListingDeps {
  readonly catalog: Pick<ModelCatalogRepository, "replaceForAccount">
}

export type CatalogRefreshOutcome =
  | { readonly kind: "refreshed"; readonly models: number }
  /** Nothing was asked: this provider has no listing to read. Not a failure. */
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string }

/**
 * Whether this Account is one the sweep asks at all.
 *
 * Three exclusions, each for its own reason:
 *
 * - **`disabled`** is the operator's own switch. Refreshing a description of an Account they turned
 *   off is work nobody asked for. Every other status is included deliberately — `exhausted` and
 *   `needs_reauth` accounts still have a catalog, and a listing costs no tokens and spends no quota
 *   window, so there is nothing to save by skipping them and a recovered credential shows up sooner.
 * - **`agent-sdk`** accounts have no listing endpoint. A Claude subscription's models are whatever
 *   Anthropic gives the subscription and the SDK owns that catalog; there is no URL to GET.
 * - **`openrouter`** is excluded by instruction, and the instruction is right: it is an aggregator
 *   of several hundred models it does not itself serve, and mirroring another aggregator's catalog
 *   hourly would make this router's listing mostly a stale copy of someone else's. The manual
 *   discover button still asks it whenever an operator wants the answer.
 */
export function isRefreshable(account: Pick<AccountRow, "provider" | "status">): boolean {
  if (account.status === "disabled") return false
  if (account.provider === "openrouter") return false
  return describeProvider(account.provider).transport === "http"
}

export async function refreshAccountCatalog(
  deps: CatalogRefreshDeps,
  account: AccountRow,
  now: Date,
): Promise<CatalogRefreshOutcome> {
  if (!isRefreshable(account)) return { kind: "skipped", reason: skipReason(account) }

  const listed = await listUpstreamModels(deps, account)
  if (!listed.ok) return { kind: "failed", reason: listed.code }

  // An empty listing is written, unlike on the discover button. There, `[]` would mean "this
  // account serves nothing" to routing and is refused for it; here the table only describes, so an
  // upstream that now lists nothing is a fact worth recording rather than one to suppress.
  const entries = listed.entries.map((entry) => catalogEntry(account.provider, entry))
  await deps.catalog.replaceForAccount(account.id, entries, now)

  return { kind: "refreshed", models: entries.length }
}

/** In the same order {@link isRefreshable} checks, so the reason names the rule that actually fired. */
function skipReason(account: Pick<AccountRow, "provider" | "status">): string {
  if (account.status === "disabled") return "account:disabled"
  if (account.provider === "openrouter") return "openrouter:aggregator"
  const { transport } = describeProvider(account.provider)
  return transport === "agent-sdk" ? "agent-sdk:no-listing" : `${transport}:no-driver`
}

import type { ModelListingSource } from "@multi-ai-router/core"
import type { AccountRow, ModelCatalogRepository } from "@multi-ai-router/db"
import { describeProvider } from "../accounts/providers"
import { catalogEntry } from "./entries"
import { listUpstreamModels, type UpstreamListingDeps } from "./listing"
import { refreshSubscriptionCatalog, type SubscriptionListingDeps } from "./subscription-refresh"

/**
 * Refresh one Account's catalog. The unit the hourly sweep repeats and the whole of what it does.
 *
 * A service rather than logic inside the task, for the reason every other sweep here is built that
 * way: the task owns the *loop* — batching, abort, tallying, the run record — and this owns the
 * work, so the interesting half is testable without a scheduler and the scheduler is testable
 * without a provider.
 *
 * Two transports, one entry point. An HTTP provider is asked through its own model listing; a
 * Claude subscription is asked through the Agent SDK's handshake (`subscription-refresh.ts`). The
 * caller sees one outcome shape either way.
 */

export interface CatalogRefreshDeps extends UpstreamListingDeps {
  readonly catalog: Pick<ModelCatalogRepository, "replaceForAccount">
  /**
   * How a Claude subscription is asked. Optional so a runtime built without an SDK (a test, a
   * deployment that serves no subscriptions) still refreshes every HTTP account; a subscription
   * under such a runtime is skipped, never failed.
   */
  readonly subscription?: SubscriptionListingDeps
}

export type CatalogRefreshOutcome =
  | {
      readonly kind: "refreshed"
      readonly models: number
      /** Which voice the rows came from. Stated by the subscription path, where it can vary. */
      readonly source?: ModelListingSource
    }
  /** Nothing was asked: this Account has no listing to read right now. Not a failure. */
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string }

/**
 * Whether this Account is one the sweep asks at all.
 *
 * The exclusions, each for its own reason:
 *
 * - **`disabled`** is the operator's own switch. Refreshing a description of an Account they turned
 *   off is work nobody asked for. Every other status is included for an HTTP account — `exhausted`
 *   and `needs_reauth` accounts still have a catalog, and a listing costs no tokens and spends no
 *   quota window, so there is nothing to save by skipping them and a recovered credential shows up
 *   sooner.
 * - **`openrouter`** is excluded by instruction, and the instruction is right: it is an aggregator
 *   of several hundred models it does not itself serve, and mirroring another aggregator's catalog
 *   hourly would make this router's listing mostly a stale copy of someone else's. The manual
 *   discover button still asks it whenever an operator wants the answer.
 * - **A `needs_reauth` subscription** is excluded where a `needs_reauth` HTTP account is not,
 *   because asking it is not free: it spawns the `claude` CLI against a directory whose credential
 *   is already known to be dead, to be told so again. The catalog it has stands until a human
 *   reconnects it, and the reconnect refreshes it on the spot.
 */
export function isRefreshable(account: Pick<AccountRow, "provider" | "status">): boolean {
  if (account.status === "disabled") return false
  if (account.provider === "openrouter") return false
  const { transport } = describeProvider(account.provider)
  if (transport === "agent-sdk") return account.status !== "needs_reauth"
  return transport === "http"
}

export async function refreshAccountCatalog(
  deps: CatalogRefreshDeps,
  account: AccountRow,
  now: Date,
): Promise<CatalogRefreshOutcome> {
  if (!isRefreshable(account)) return { kind: "skipped", reason: skipReason(account) }

  if (describeProvider(account.provider).transport === "agent-sdk") {
    if (deps.subscription === undefined) return { kind: "skipped", reason: "agent-sdk:no-lister" }
    return refreshSubscriptionCatalog(
      { catalog: deps.catalog, subscription: deps.subscription },
      account,
      now,
    )
  }

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
  if (transport === "agent-sdk") return "agent-sdk:needs-reauth"
  return `${transport}:no-driver`
}

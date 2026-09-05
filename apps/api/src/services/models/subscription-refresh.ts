import type { AccountRow, ModelCatalogRepository } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import type { SdkModelLister } from "../../providers"
import type { CatalogRefreshOutcome } from "./refresh"
import { shippedSubscriptionCatalog, subscriptionCatalog } from "./subscription"

/**
 * Refresh one Claude subscription's catalog: ask the Agent SDK, fall back to the shipped table.
 *
 * The subscription half of `refreshAccountCatalog`, split out because it changes for a different
 * reason than the HTTP half — a provider listing is a GET on a credential, this is a subprocess
 * handshake on a directory — and because the fallback rule is the interesting decision here:
 *
 * - **A live answer is written as it came**, aliases and resolutions included.
 * - **An unavailable answer (`null`) writes the shipped table**, labelled `shipped`. A pool of
 *   subscriptions must never list nothing because a binary was missing or a handshake was slow;
 *   this image knows what a subscription serves, and says so until the live voice is back.
 * - **An auth failure writes nothing.** The credential needs a human, the account is about to be
 *   `needs_reauth` by the health path, and overwriting a good live listing with the shipped one
 *   would make a dead credential look like a downgrade. The previous rows stand.
 *
 * None of these fails the tick. One dead subscription is that subscription's problem, logged at
 * info with the reason, never a `failed` outcome that turns the sweep partial.
 */

export interface SubscriptionListingDeps {
  readonly lister: Pick<SdkModelLister, "list">
  /** Bounds the whole handshake — slot wait, spawn, `system/init`. Config, never a constant. */
  readonly timeoutMs: number
  readonly logger: Logger
}

export interface SubscriptionRefreshDeps {
  readonly catalog: Pick<ModelCatalogRepository, "replaceForAccount">
  readonly subscription: SubscriptionListingDeps
}

export async function refreshSubscriptionCatalog(
  deps: SubscriptionRefreshDeps,
  account: AccountRow,
  now: Date,
): Promise<CatalogRefreshOutcome> {
  const { lister, timeoutMs, logger } = deps.subscription
  const fields = { accountId: account.id, provider: account.provider }

  if (account.configDir === null) {
    // Nothing to spawn against: the login never finished. The connect flow owns that state.
    logger.info("subscription model listing skipped: no config directory", fields)
    return { kind: "skipped", reason: "agent-sdk:no-config-dir" }
  }

  const listing = await lister.list({
    accountId: account.id,
    configDir: account.configDir,
    timeoutMs,
  })

  if (listing?.kind === "auth") {
    logger.info("subscription model listing skipped: credential needs re-auth", fields)
    return { kind: "skipped", reason: "agent-sdk:needs-reauth" }
  }

  if (listing === null) {
    const entries = shippedSubscriptionCatalog()
    await deps.catalog.replaceForAccount(account.id, entries, now)
    logger.info("subscription model listing unavailable; shipped table stands in", {
      ...fields,
      models: entries.length,
    })
    return { kind: "refreshed", models: entries.length, source: "shipped" }
  }

  const entries = subscriptionCatalog(listing.models)
  await deps.catalog.replaceForAccount(account.id, entries, now)
  return { kind: "refreshed", models: entries.length, source: "live" }
}

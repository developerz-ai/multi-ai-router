import { isStandingBlock, type ProviderId } from "@multi-ai-router/core"
import { resolveScope } from "../routing"
import type { VerifiedKey } from "./auth/verifier"
import { buildSnapshot, type HealthStore } from "./health"
import type { RoutingCatalog } from "./types"

/**
 * The models reachable by the presenting key.
 *
 * "Reachable" means the same intersection everything else does — an out-of-scope Account is not
 * deprioritized here, it does not exist, including in this listing
 * (docs/idea/04-api-keys-and-access.md). Two keys pointed at the same router therefore see two
 * different catalogs, which is the whole point of scope.
 *
 * Names are **requested-side**: an Account that maps `sonnet` -> `glm-4.7` advertises `sonnet`,
 * because that is what a client sends. The alias is outbound-only.
 *
 * An Account that declares no model set supports everything — unknown is passthrough, not
 * exclusion — and therefore contributes no enumerable name. A deployment of only such Accounts
 * lists nothing rather than inventing a catalog it cannot stand behind.
 *
 * An Account under a **standing** block (`disabled`, `exhausted`, `needs_reauth`) contributes
 * nothing either: listing a model no request can be served by sends the client to a 503 it could
 * have been spared. A `cooling_down` Account still contributes, deliberately — that block clears
 * on a clock, and a model that blinked out of the catalog for the length of a cooldown would look
 * to a client like the router had lost it.
 */

export interface ReachableModel {
  readonly id: string
  /** The first in-scope provider offering it. Listings want an owner, not the whole set. */
  readonly owner: ProviderId
}

export function reachableModels(
  catalog: RoutingCatalog,
  health: HealthStore,
  key: VerifiedKey,
  now: Date,
): readonly ReachableModel[] {
  const snapshot = buildSnapshot(catalog, health, now)
  const { diagnostics } = resolveScope(snapshot, {
    sessionKey: "",
    model: "",
    keyScope: key.scope,
  })

  const inScope = new Set(diagnostics.inScopeAccountIds)
  // Live status, not the catalog's stored one: the health store is what knows an account went
  // `exhausted` thirty seconds ago, and the catalog only knows what the operator last saved.
  const liveStatus = new Map(snapshot.accounts.map((account) => [account.id, account.status]))
  const owners = new Map<string, ProviderId>()

  for (const account of catalog.accounts()) {
    if (!inScope.has(account.id)) continue
    if (isStandingBlock(liveStatus.get(account.id) ?? account.snapshot.status)) continue
    for (const name of advertisedNames(
      account.snapshot.supportedModels,
      account.driver.modelAliases,
    )) {
      if (!owners.has(name)) owners.set(name, account.driver.provider)
    }
  }

  return [...owners]
    .map(([id, owner]) => ({ id, owner }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function advertisedNames(
  supported: readonly string[] | undefined,
  aliases: Readonly<Record<string, string>> | null | undefined,
): readonly string[] {
  // Alias *keys* are requested-side names; the values are what the upstream is told.
  return [...(supported ?? []), ...Object.keys(aliases ?? {})]
}

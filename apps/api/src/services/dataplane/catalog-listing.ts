import {
  isStandingBlock,
  type ModelContextSource,
  type ModelDescriptor,
  type ProviderId,
} from "@multi-ai-router/core"
import type { RateCard } from "../cost"
import type { ModelCatalogStore } from "../models"
import { advertisedModels, resolveModel, resolveScope } from "../routing"
import type { VerifiedKey } from "./auth/verifier"
import type { HealthStore } from "./health"
import { buildSnapshot } from "./snapshot"
import type { RoutingCatalog } from "./types"

/**
 * The **rich** catalog behind `GET /v1/catalog`: every model the presenting key can reach, with how
 * much fits in it, what it costs, and which providers serve it.
 *
 * A separate endpoint from `GET /v1/models` rather than more fields on it, deliberately.
 * `/v1/models` is a wire contract — an OpenAI or Anthropic client parses it with a generated SDK,
 * and this router's job there is to answer in the shape those clients expect and nothing more. This
 * is the router's *own* listing, so it can say things neither of those shapes has a place for.
 *
 * Scope is enforced by exactly one implementation. The model set comes from the same intersection
 * `reachableModels` uses — pool members ∩ key scope, standing blocks dropped — because a second
 * opinion about what a key can reach is a second place for it to be wrong, and this one would be
 * wrong in the direction of *publishing a catalog of models the presenting key cannot use*.
 */

/** One model, as this router can describe it, unioned across every in-scope account serving it. */
export interface CatalogModel {
  /** Requested-side name: what a client sends. */
  readonly id: string
  /** Every in-scope provider that serves it, in the enum's order. */
  readonly providers: readonly ProviderId[]
  /** How many in-scope accounts serve it — the pooling depth behind this name. */
  readonly accounts: number
  readonly contextTokens: number | null
  readonly maxOutputTokens: number | null
  readonly contextSource: ModelContextSource | null
  /**
   * US dollars per million tokens, or null where this image ships no price and no operator set one.
   * Null is **unknown**, never free — the same rule the usage reports follow.
   */
  readonly pricing: RateCard | null
}

export interface CatalogListingDeps {
  readonly catalog: RoutingCatalog
  readonly health: HealthStore
  readonly models: Pick<ModelCatalogStore, "describe" | "modelsOf">
  /** The warm book, so an operator's price override shows up here as it does in a usage report. */
  readonly prices: (provider: ProviderId, model: string) => RateCard | null
}

export function catalogListing(
  deps: CatalogListingDeps,
  key: VerifiedKey,
  now: Date,
): readonly CatalogModel[] {
  const snapshot = buildSnapshot(deps.catalog, deps.health, now)
  const { diagnostics } = resolveScope(snapshot, { sessionKey: "", model: "", keyScope: key.scope })
  const inScope = new Set(diagnostics.inScopeAccountIds)
  // Live status, not the catalog's stored one: the health store is what knows an account went
  // `exhausted` thirty seconds ago. `cooling_down` accounts still contribute — that block clears on
  // a clock, and a model that blinked out of a catalog for the length of a cooldown would look to a
  // client like the router had lost it.
  const liveStatus = new Map(snapshot.accounts.map((account) => [account.id, account.status]))

  const merged = new Map<string, Mutable>()

  for (const account of deps.catalog.accounts()) {
    if (!inScope.has(account.id)) continue
    if (isStandingBlock(liveStatus.get(account.id) ?? account.snapshot.status)) continue

    for (const name of requestableNames(deps, account.id, account.snapshot)) {
      const upstream = resolveModel(account.snapshot, name).upstreamModel
      absorb(
        merged,
        name,
        account.driver.provider,
        deps.models.describe(account.id, upstream),
        deps.prices(account.driver.provider, upstream),
      )
    }
  }

  return [...merged.values()].map(finish).sort((left, right) => left.id.localeCompare(right.id))
}

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
  /** In-scope accounts of this provider, whatever their status. */
  readonly accounts: number
  /**
   * How many of them could serve a request now. Zero with a non-zero `accounts` is the state worth
   * seeing — the credentials exist and none of them can be used.
   */
  readonly available: number
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

  const counts = new Map<ProviderId, { accounts: number; available: number }>()
  for (const account of deps.catalog.accounts()) {
    if (!inScope.has(account.id)) continue
    const provider = account.driver.provider
    const row = counts.get(provider) ?? { accounts: 0, available: 0 }
    row.accounts += 1
    // `cooling_down` counts as available for the same reason it stays in the model catalog: a clock
    // clears it, and a provider that vanished for the length of a cooldown would read as removed.
    if (!isStandingBlock(liveStatus.get(account.id) ?? account.snapshot.status)) row.available += 1
    counts.set(provider, row)
  }

  return [...counts]
    .map(([id, row]) => ({ id, ...row }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

/** The routing catalog's account view, narrowed to what this module reads. */
type CatalogAccount = ReturnType<RoutingCatalog["accounts"]>[number]

/**
 * Every name a client may **send** this account: what routing already advertises, plus what the
 * upstream's own listing turned up.
 *
 * The second half is the reason this file is not simply `reachableModels` with extra columns. An
 * account declaring no `supported_models` is a passthrough — it serves any name — so it advertises
 * only the alias keys an operator happened to write down, and a freshly connected z.ai account
 * advertises *nothing*. Its upstream, meanwhile, has told the hourly sweep exactly which models it
 * serves. Listing those is the difference between a catalog and an empty page.
 *
 * A discovered id is admitted only if `resolveModel` says a request for it would be served, which
 * is the same check selection runs. That matters in both directions: an account that *does* declare
 * a model set must not have retired ids resurface through the catalog, and one whose alias map
 * renames an id must not advertise a name that would be renamed to something unserved.
 */
function requestableNames(
  deps: Pick<CatalogListingDeps, "models">,
  accountId: string,
  snapshot: CatalogAccount["snapshot"],
): readonly string[] {
  const names = new Set(advertisedModels(snapshot))
  for (const model of deps.models.modelsOf(accountId)) {
    if (resolveModel(snapshot, model.id).supported) names.add(model.id)
  }
  return [...names]
}

interface Mutable {
  readonly id: string
  readonly providers: Set<ProviderId>
  accounts: number
  contextTokens: number | null
  maxOutputTokens: number | null
  contextSource: ModelContextSource | null
  pricing: RateCard | null
}

/**
 * Fold one account's answer into the merged row.
 *
 * **First known answer wins, and a known answer beats an unknown one.** Two accounts of the same
 * provider serve the same model at the same size, so the common case is agreement; where they
 * disagree it is because one has been swept and the other has not, and the swept one is the one
 * worth showing. Later accounts never overwrite an established number — a stable listing matters
 * more than an arbitrary tie-break, and there is no basis for preferring the second answer.
 */
function absorb(
  merged: Map<string, Mutable>,
  id: string,
  provider: ProviderId,
  described: ModelDescriptor | null,
  pricing: RateCard | null,
): void {
  const row =
    merged.get(id) ??
    ({
      id,
      providers: new Set<ProviderId>(),
      accounts: 0,
      contextTokens: null,
      maxOutputTokens: null,
      contextSource: null,
      pricing: null,
    } satisfies Mutable)

  row.providers.add(provider)
  row.accounts += 1
  if (row.contextTokens === null && described?.contextTokens != null) {
    row.contextTokens = described.contextTokens
    // The label travels with the number it describes. Taking it from a different account's row
    // would be the mixed-provenance row `services/models/entries.ts` refuses to build.
    row.contextSource = described.contextSource
  }
  row.maxOutputTokens ??= described?.maxOutputTokens ?? null
  row.pricing ??= pricing

  merged.set(id, row)
}

function finish(row: Mutable): CatalogModel {
  return {
    id: row.id,
    providers: [...row.providers].sort(),
    accounts: row.accounts,
    contextTokens: row.contextTokens,
    maxOutputTokens: row.maxOutputTokens,
    contextSource: row.contextSource,
    pricing: row.pricing,
  }
}

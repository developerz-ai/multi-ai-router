import {
  isStandingBlock,
  type ModelContextSource,
  type ModelDescriptor,
  type ModelReasoning,
  type ProviderId,
} from "@multi-ai-router/core"
import type { ModelRates } from "../cost"
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
 * A separate endpoint from `GET /v1/models`, deliberately. `/v1/models` is a wire contract — an
 * OpenAI or Anthropic client parses it with a generated SDK — so it carries only the size fields those
 * shapes already define (`max_input_tokens`/`max_tokens`, `context_length`/`max_completion_tokens`).
 * This is the router's *own* listing, so it can say things neither of those shapes has a place for.
 *
 * Scope is enforced by exactly one implementation. The model set comes from the same intersection
 * `reachableModels` uses — pool members ∩ key scope, standing blocks dropped — because a second
 * opinion about what a key can reach is a second place for it to be wrong, and this one would be
 * wrong in the direction of *publishing a catalog of models the presenting key cannot use*.
 */

/** One provider's answer for a model: what its in-scope accounts serving the name can take. */
export interface CatalogOffer {
  readonly provider: ProviderId
  readonly accounts: number
  readonly contextTokens: number | null
  readonly maxOutputTokens: number | null
  readonly contextSource: ModelContextSource | null
  readonly pricing: ModelRates | null
}

/** One model, as this router can describe it, unioned across every in-scope account serving it. */
export interface CatalogModel {
  /** Requested-side name: what a client sends. */
  readonly id: string
  /** Every in-scope provider that serves it, in the enum's order. */
  readonly providers: readonly ProviderId[]
  /** How many in-scope accounts serve it — the pooling depth behind this name. */
  readonly accounts: number
  /**
   * The smallest known size among the accounts behind the name, because the router may send a
   * request to any of them: a client sizing a prompt from this number fits every one. Unknown
   * (null) only when no account states one.
   */
  readonly contextTokens: number | null
  readonly maxOutputTokens: number | null
  /** Where {@link contextTokens} came from: the label of the account whose number it is. */
  readonly contextSource: ModelContextSource | null
  /**
   * US dollars per million tokens, or null where this image ships no price and no operator set one.
   * Null is **unknown**, never free — the same rule the usage reports follow.
   */
  readonly pricing: ModelRates | null
  /** Each in-scope provider's own answer, in the enum's order. Additive to the fields above. */
  readonly offers: readonly CatalogOffer[]
  /** The upstream listing's word on thinking modes. Absent when no serving account stated one. */
  readonly reasoning?: ModelReasoning
}

export interface CatalogListingDeps {
  readonly catalog: RoutingCatalog
  readonly health: HealthStore
  readonly models: Pick<ModelCatalogStore, "describe" | "modelsOf">
  /** The warm book, so an operator's price override shows up here as it does in a usage report. */
  readonly prices: (provider: ProviderId, model: string) => ModelRates | null
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

interface Sizes {
  accounts: number
  contextTokens: number | null
  maxOutputTokens: number | null
  contextSource: ModelContextSource | null
  pricing: ModelRates | null
}

interface Mutable extends Sizes {
  readonly id: string
  readonly offers: Map<ProviderId, Sizes>
  /** First known answer wins: a thinking mode is a property of the model, not a size. */
  reasoning?: ModelReasoning
}

/**
 * Fold one account's answer into the merged row and into its provider's offer.
 *
 * **The smallest known size wins, and a known answer beats an unknown one.** Selection may place
 * the request on any account behind the name, so the size a client can rely on is the one every
 * account can take; first-answer-wins published the first account's number and a prompt sized from
 * it failed on a smaller sibling. An unknown size says nothing about the account, so it never
 * shrinks a known one. A price is not a size: the first known one stands, as before.
 */
function absorb(
  merged: Map<string, Mutable>,
  id: string,
  provider: ProviderId,
  described: ModelDescriptor | null,
  pricing: ModelRates | null,
): void {
  const row = merged.get(id) ?? { id, offers: new Map<ProviderId, Sizes>(), ...emptySizes() }
  const offer = row.offers.get(provider) ?? emptySizes()
  for (const sizes of [row, offer]) fold(sizes, described, pricing)
  row.offers.set(provider, offer)
  if (row.reasoning === undefined && described?.reasoning !== undefined) {
    row.reasoning = described.reasoning
  }
  merged.set(id, row)
}

function emptySizes(): Sizes {
  return {
    accounts: 0,
    contextTokens: null,
    maxOutputTokens: null,
    contextSource: null,
    pricing: null,
  }
}

function fold(sizes: Sizes, described: ModelDescriptor | null, pricing: ModelRates | null): void {
  sizes.accounts += 1
  const context = described?.contextTokens ?? null
  if (context !== null && (sizes.contextTokens === null || context < sizes.contextTokens)) {
    sizes.contextTokens = context
    // The label travels with the number it describes. Taking it from a different account's row
    // would be the mixed-provenance row `services/models/entries.ts` refuses to build.
    sizes.contextSource = described?.contextSource ?? null
  }
  const output = described?.maxOutputTokens ?? null
  if (output !== null && (sizes.maxOutputTokens === null || output < sizes.maxOutputTokens))
    sizes.maxOutputTokens = output
  sizes.pricing ??= pricing
}

function finish(row: Mutable): CatalogModel {
  const offers = [...row.offers]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, sizes]) => ({ provider, ...sizes }))
  return {
    id: row.id,
    providers: offers.map((offer) => offer.provider),
    accounts: row.accounts,
    contextTokens: row.contextTokens,
    maxOutputTokens: row.maxOutputTokens,
    contextSource: row.contextSource,
    pricing: row.pricing,
    offers,
    ...(row.reasoning === undefined ? {} : { reasoning: row.reasoning }),
  }
}

/**
 * The model catalog — what this router can reach and how much fits in it.
 *
 * Callers import from here; nothing outside this directory reaches into a module inside it.
 *
 * Deliberately **not** `services/catalog/`, which is the warm *routing* catalog: the accounts,
 * pools and keys selection reads on every request. The two words mean different things and the
 * directories keep them apart. Everything here is on the describing side of that line —
 * `accounts.supported_models` decides where a request may land and stays operator-owned, while this
 * reads an upstream's listing, fills what it did not say from a shipped table, and stores the
 * result for a console and a public listing to render. Nothing in selection imports this.
 */

export { catalogEntry } from "./entries"
export type {
  ListingFailureCode,
  UpstreamListing,
  UpstreamListingDeps,
  UpstreamModelEntry,
} from "./listing"
export { listUpstreamModels, NOT_HTTP } from "./listing"
export type { CatalogRefreshDeps, CatalogRefreshOutcome } from "./refresh"
export { isRefreshable, refreshAccountCatalog } from "./refresh"
export { selectForRefresh } from "./select"
export type { ModelCatalogStore, ModelCatalogStoreDeps } from "./store"
export { createModelCatalogStore } from "./store"
export { CONTEXT_TABLE_AS_OF, lookupContextWindow } from "./windows"

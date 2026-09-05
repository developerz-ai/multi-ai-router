import {
  type ModelContextSource,
  type ModelDescriptor,
  ModelListingSource,
} from "@multi-ai-router/core"
import type { ModelCatalogRow } from "@multi-ai-router/db"

/**
 * The warm model catalog: what each Account's upstream last said it serves, held in memory and
 * refreshed off the request path.
 *
 * `describe` is **synchronous by design**, the same reason `PriceBook.lookup` is. The catalog
 * listing renders one row per reachable model and would otherwise issue a query per model or hold a
 * whole table read open while it serialized — and while a listing is not the inference critical
 * path, "the endpoint that enumerates the router" is exactly the one an operator hits in a loop.
 * Everything that can be slow is a `refresh`.
 *
 * Refreshed the three ways the price book is: awaited at boot, on a jittered timer so an hourly
 * sweep run by *another* replica lands here without a broker, and — unlike the price book — never
 * awaited by an admin write, because nothing an operator does through the console writes this
 * table. Only the sweep does.
 *
 * A failed refresh keeps the previous snapshot: a slightly stale catalog beats an empty one, and an
 * empty one reads as "this router serves nothing".
 */

export interface ModelCatalogStore {
  /**
   * What is known about one Account's model, or null. Keyed by **upstream-side** id — the side the
   * provider's listing returns and the side an alias map points at.
   */
  describe(accountId: string, upstreamModel: string): ModelDescriptor | null
  /**
   * Every model this Account's upstream last listed, in the order the sweep stored them.
   *
   * The half of this store that {@link ModelCatalogStore.describe} cannot answer: an Account
   * declaring no `supported_models` is a passthrough and therefore advertises nothing enumerable,
   * yet its upstream told us exactly what it serves. Without this the catalog listing for a freshly
   * connected provider would be empty while the table behind it was full.
   */
  modelsOf(accountId: string): readonly ModelDescriptor[]
  /** Re-reads the table. Rejects on failure, leaving the last good snapshot in place. */
  refresh(): Promise<void>
  /** Begins periodic refresh. Idempotent. */
  start(): void
  stop(): void
  /** When the held rows were last replaced. `null` before the first successful load. */
  loadedAt(): Date | null
}

export interface ModelCatalogStoreDeps {
  readonly load: () => Promise<readonly ModelCatalogRow[]>
  /** Staleness bound for a sweep run by another replica. Config, never a constant. */
  readonly refreshIntervalMs: number
  readonly now?: () => Date
  /** Injected so a test is deterministic; production leaves it alone. */
  readonly jitter?: (intervalMs: number) => number
}

/** `accountId -> upstream model -> what is known`. Empty until the first successful load. */
type Snapshot = ReadonlyMap<string, ReadonlyMap<string, ModelDescriptor>>

const EMPTY: Snapshot = new Map()

export function createModelCatalogStore(deps: ModelCatalogStoreDeps): ModelCatalogStore {
  const now = deps.now ?? (() => new Date())
  const jitter = deps.jitter ?? defaultJitter
  let snapshot: Snapshot = EMPTY
  let loadedAt: Date | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  // Concurrent refreshes would be two identical queries racing to install the same snapshot;
  // callers share the one in flight instead.
  let inFlight: Promise<void> | null = null

  const refresh = (): Promise<void> => {
    inFlight ??= deps
      .load()
      .then((rows) => {
        snapshot = index(rows)
        loadedAt = now()
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  const schedule = (): void => {
    timer = setTimeout(() => {
      // Swallowed on purpose: a periodic refresh that throws must not take the process down, and
      // the next tick retries. The snapshot stays as it was.
      void refresh().catch(() => undefined)
      if (timer !== null) schedule()
    }, jitter(deps.refreshIntervalMs))
    timer.unref?.()
  }

  return {
    describe: (accountId, upstreamModel) =>
      snapshot.get(accountId)?.get(upstreamModel.trim().toLowerCase()) ?? null,
    modelsOf: (accountId) => [...(snapshot.get(accountId)?.values() ?? [])],
    refresh,
    start: () => {
      if (timer === null) schedule()
    },
    stop: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
    loadedAt: () => loadedAt,
  }
}

/**
 * Indexed case-insensitively, because the two sides of this lookup come from different places: the
 * key is written by whatever the provider's listing said, and the question is asked with whatever a
 * client sent through an alias map. `MiniMax-M2` and `minimax-m2` are one model, and a catalog that
 * rendered an unknown window for the second spelling would look like a gap in the sweep.
 */
function index(rows: readonly ModelCatalogRow[]): Snapshot {
  const byAccount = new Map<string, Map<string, ModelDescriptor>>()
  for (const row of rows) {
    const table = byAccount.get(row.accountId) ?? new Map<string, ModelDescriptor>()
    table.set(row.modelId.trim().toLowerCase(), {
      id: row.modelId,
      contextTokens: row.contextTokens,
      maxOutputTokens: row.maxOutputTokens,
      contextSource: normalizeSource(row.contextSource),
      listingSource: normalizeListingSource(row.listingSource),
      resolvedModel: row.resolvedModel,
    })
    byAccount.set(row.accountId, table)
  }
  return byAccount
}

/**
 * The column is `text` rather than a Postgres enum, by the rule that a label only *describing* a
 * reading should not need a migration to learn a new value. The cost of that choice is exactly here:
 * a row written by a future build with a source this one has never heard of is read as an unlabelled
 * number rather than as a `ModelContextSource` it cannot honour.
 */
function normalizeSource(value: string | null): ModelContextSource | null {
  return value === "upstream" || value === "shipped" ? value : null
}

/**
 * Same rule as above, with one difference: a row has to have come from *somewhere*, so an
 * unrecognised label reads as the column's own default rather than as nothing.
 */
function normalizeListingSource(value: string): ModelListingSource {
  const parsed = ModelListingSource.safeParse(value)
  return parsed.success ? parsed.data : "upstream"
}

/**
 * ±20%. Replicas start together — under a fixed interval they would refresh in lockstep for the
 * life of the deployment, turning a cheap query into a synchronised burst.
 */
function defaultJitter(intervalMs: number): number {
  return Math.round(intervalMs * (0.8 + Math.random() * 0.4))
}

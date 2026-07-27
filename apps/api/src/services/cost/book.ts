import type { ProviderId } from "@multi-ai-router/core"
import type { PriceOverrideRow } from "@multi-ai-router/db"
import { lookupRates } from "./prices"
import { type ModelRates, modelLookupKeys } from "./rates"

/**
 * The warm price book: the operator's price overrides, held in memory and refreshed off the request
 * path, layered over the table shipped with the image.
 *
 * `lookup` is **synchronous by design**, and that is the reason this exists rather than a repository
 * call inside `estimateCost`. Every usage record is priced while the request is still being served,
 * so a lookup that could await a query would put Postgres on the critical path — CLAUDE.md
 * non-negotiable 8 forbids it. Everything that can be slow is a `refresh`.
 *
 * Refresh happens the same three ways the routing catalog refreshes, for the same reasons: awaited
 * at boot so the first request prices correctly, awaited by the admin service after an edit so the
 * console is read-after-write consistent, and on a jittered timer so an edit made by *another
 * replica* lands here without a broker.
 *
 * A failed refresh keeps the previous snapshot. Serving a slightly stale price beats serving none:
 * the alternative is reverting to the shipped numbers — silently, mid-flight — because one periodic
 * query timed out, which is exactly the kind of unexplained jump in a spend column that makes a
 * report untrustworthy.
 *
 * Overrides never *remove* a price. An entry wins for the provider + model it names and nothing
 * else falls back to unknown, so correcting one stale rate cannot cost the deployment the rest of
 * the table.
 */

export interface PriceBook {
  /** Synchronous by design: the request path may never await a query here. */
  lookup(provider: ProviderId, model: string): ModelRates | null
  /** Re-reads the overrides. Rejects on failure, leaving the last good snapshot in place. */
  refresh(): Promise<void>
  /** Begins periodic refresh. Idempotent. */
  start(): void
  stop(): void
  /** When the held overrides were last replaced. `null` before the first successful load. */
  loadedAt(): Date | null
}

export interface PriceBookDeps {
  readonly load: () => Promise<readonly PriceOverrideRow[]>
  /** Staleness bound for an edit made by another replica. Config, never a constant. */
  readonly refreshIntervalMs: number
  readonly now?: () => Date
  /** Injected so a test is deterministic; production leaves it alone. */
  readonly jitter?: (intervalMs: number) => number
}

/** `provider -> normalized model -> rates`. Empty until the first successful load. */
type Overrides = ReadonlyMap<ProviderId, ReadonlyMap<string, ModelRates>>

const EMPTY: Overrides = new Map()

export function createPriceBook(deps: PriceBookDeps): PriceBook {
  const now = deps.now ?? (() => new Date())
  const jitter = deps.jitter ?? defaultJitter
  let overrides: Overrides = EMPTY
  let loadedAt: Date | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  // Concurrent refreshes would be two identical queries racing to install the same snapshot;
  // callers share the one in flight instead.
  let inFlight: Promise<void> | null = null

  const refresh = (): Promise<void> => {
    inFlight ??= deps
      .load()
      .then((rows) => {
        overrides = index(rows)
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
    lookup: (provider, model) => {
      const table = overrides.get(provider)
      if (table !== undefined) {
        // Both keys are tried against the overrides before the shipped table is consulted at all:
        // an operator who priced the family meant it to cover the dated pin too.
        const [name, family] = modelLookupKeys(model)
        const override = table.get(name) ?? table.get(family)
        if (override !== undefined) return override
      }
      return lookupRates(provider, model)
    },
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
 * Rows are stored already normalized and the unique index keeps them so, but the name is normalized
 * again here rather than trusted: a row written by an older build costs one `toLowerCase` to
 * rescue, and a price that silently never matches is invisible until a report is wrong.
 */
function index(rows: readonly PriceOverrideRow[]): Overrides {
  const byProvider = new Map<ProviderId, Map<string, ModelRates>>()
  for (const row of rows) {
    const table = byProvider.get(row.provider) ?? new Map<string, ModelRates>()
    const [name] = modelLookupKeys(row.model)
    table.set(name, {
      inputPerMtok: row.inputPerMtok,
      outputPerMtok: row.outputPerMtok,
      cacheReadPerMtok: row.cacheReadPerMtok,
      cacheWritePerMtok: row.cacheWritePerMtok,
    })
    byProvider.set(row.provider, table)
  }
  return byProvider
}

/**
 * ±20%. Replicas start together — under a fixed interval they would refresh in lockstep for the
 * life of the deployment, turning a cheap query into a synchronised burst.
 */
function defaultJitter(intervalMs: number): number {
  return Math.round(intervalMs * (0.8 + Math.random() * 0.4))
}

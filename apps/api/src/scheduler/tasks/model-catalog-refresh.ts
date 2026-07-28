import type { AccountRepository, AccountRow, ModelCatalogRepository } from "@multi-ai-router/db"
import { type CatalogRefreshOutcome, selectForRefresh } from "../../services/models"
import type { ScheduledTask } from "../types"

/**
 * Keeps the model catalog current — **the description, never the routing.**
 *
 * This is the one distinction worth being careful about, because the repository already contains a
 * decision that reads like its opposite. `accounts.supported_models` says, on the column itself,
 * that it is "deliberately not refreshed on a timer: a model catalog that changes under a running
 * deployment would change routing without an operator ever asking for it". That still holds and
 * this task does not touch that column. It writes `model_catalog`, which nothing in selection
 * reads: an upstream retiring a model changes what the console and the public listing *say*, and
 * changes nothing about where a request lands.
 *
 * Hourly, because that is the cadence at which a catalog is worth having: model ids and context
 * windows move on the order of weeks, and a listing costs no tokens and spends no quota window, so
 * the sweep is nearly free. Contrast the idle-account keepalive next door, which bills a real turn
 * and therefore runs daily against a seven-day threshold.
 *
 * **Bounded, idempotent, resumable**, like every task here: one batch per tick, abort checked
 * between accounts, each Account's catalog replaced in its own transaction so a shutdown halfway
 * through leaves whole rows rather than half a listing. Running twice writes the same thing twice.
 */

export interface ModelCatalogRefreshDeps {
  readonly accounts: Pick<AccountRepository, "list">
  /** Read only to order the batch by staleness — the writes go through {@link refresh}. */
  readonly catalog: Pick<ModelCatalogRepository, "lastRefreshedAt">
  /**
   * One Account's refresh, handed in rather than rebuilt, so the sweep and the admin plane's
   * discover button ask an upstream through exactly one parser.
   */
  readonly refresh: (account: AccountRow, now: Date) => Promise<CatalogRefreshOutcome>
  /** `MODEL_CATALOG_REFRESH_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
  /**
   * Accounts refreshed per tick. Each is one outbound GET, so this bounds concurrency against a
   * provider rather than memory — nothing like the keepalive's subprocess bound, and nothing like
   * a delete sweep's row bound either.
   */
  readonly batchSize: number
}

export function createModelCatalogRefreshTask(deps: ModelCatalogRefreshDeps): ScheduledTask {
  return {
    name: "model_catalog_refresh",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }) => {
      const [accounts, ages] = await Promise.all([
        deps.accounts.list(),
        deps.catalog.lastRefreshedAt(),
      ])
      // Most stale first, capped at the batch, non-refreshable accounts already dropped. The
      // ordering is what makes the cap a rate limit rather than a horizon — see `select.ts`.
      const due = selectForRefresh(accounts, ages, deps.batchSize)
      const tally = { refreshed: 0, models: 0, skipped: 0, failed: 0 }

      for (const account of due) {
        if (signal.aborted) {
          logger.info("model catalog refresh", { outcome: "partial", ...tally })
          return { outcome: "partial", itemsProcessed: tally.refreshed }
        }

        const outcome = await deps.refresh(account, now)
        if (outcome.kind === "refreshed") {
          tally.refreshed += 1
          tally.models += outcome.models
          continue
        }
        if (outcome.kind === "skipped") {
          tally.skipped += 1
          continue
        }

        tally.failed += 1
        // The listing failed, and the Account keeps the catalog it had. A stale description is a
        // better answer than an empty one, and this task writes no status of its own — a `401` here
        // is the credential's problem, which the health path already owns.
        logger.warn("model catalog refresh failed for an account", {
          accountId: account.id,
          provider: account.provider,
          reason: outcome.reason,
        })
      }

      const outcome = tally.failed > 0 ? "partial" : "success"
      // `due` beside `accounts` so a batch that is capping every tick is visible rather than
      // inferred: a deployment where `due` is always `batchSize` is one whose catalog lags.
      logger.info("model catalog refresh", {
        outcome,
        ...tally,
        due: due.length,
        accounts: accounts.length,
      })
      return { outcome, itemsProcessed: tally.refreshed }
    },
  }
}

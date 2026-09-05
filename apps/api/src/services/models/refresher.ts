import { describeError } from "@multi-ai-router/core"
import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import type { CatalogRefreshOutcome } from "./refresh"

/**
 * `refreshSubscriptionModels` — one Account's catalog refresh, callable from outside the sweep.
 *
 * The hourly sweep is the steady state; this is the moment that matters. An operator who has just
 * finished a Claude login is looking at the console, and a client behind the same pool may already
 * be filling a model picker. Waiting for the next tick means both see `data: []` for up to an hour,
 * which reads as a broken router rather than a sweep that has not come round. So the login
 * completion path calls this, with the row it just wrote or just its id.
 *
 * It is the **same refresh** the sweep runs — one code path, one parser, one write — plus the one
 * thing a sweep never needs: warming the in-memory store immediately, so the listing reflects the
 * write before the store's next jittered reload.
 *
 * Never throws. A failed refresh here is a log line and an outcome, never a failed login.
 */

export type RefreshSubscriptionModels = (
  account: AccountRow | string,
) => Promise<CatalogRefreshOutcome>

export interface SubscriptionModelRefreshDeps {
  readonly accounts: Pick<AccountRepository, "findById">
  /** The sweep's own unit of work, handed in so the two can never disagree about what a refresh is. */
  readonly refresh: (account: AccountRow, now: Date) => Promise<CatalogRefreshOutcome>
  /** Reloads the warm store. Awaited, so a caller that responds after this responds with the rows. */
  readonly onRefreshed: () => Promise<void>
  readonly logger: Logger
  readonly now: () => Date
}

export function createSubscriptionModelRefresh(
  deps: SubscriptionModelRefreshDeps,
): RefreshSubscriptionModels {
  return async (target) => {
    const account = typeof target === "string" ? await deps.accounts.findById(target) : target
    if (account === undefined) {
      const accountId = typeof target === "string" ? target : target.id
      deps.logger.info("subscription model refresh skipped: no such account", { accountId })
      return { kind: "skipped", reason: "account:unknown" }
    }

    const fields = { accountId: account.id, provider: account.provider }
    try {
      const outcome = await deps.refresh(account, deps.now())
      if (outcome.kind === "refreshed") {
        await deps.onRefreshed()
        deps.logger.info("subscription models refreshed", {
          ...fields,
          models: outcome.models,
          source: outcome.source ?? "upstream",
        })
      }
      return outcome
    } catch (error) {
      const reason = describeError(error, Number.POSITIVE_INFINITY)
      deps.logger.warn("subscription model refresh failed", { ...fields, error: reason })
      return { kind: "failed", reason }
    }
  }
}

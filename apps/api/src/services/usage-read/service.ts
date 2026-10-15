import type { UsageHistoryRepository, UsageRecentRepository } from "@multi-ai-router/db"
import { type AdminResult, invalid, ok } from "../admin/result"
import { exportFilename, overCapMessage, renderUsageCsv, type UsageCsv } from "./export"
import { resolveUsageFilter, type UsageFilterQuery } from "./filter"
import { resolveReadWindow } from "./read-window"
import { outcomesFor, type RecentQuery, type RecentView, toRecentAttemptView } from "./recent"
import { readSummary } from "./summary"
import { keyNames } from "./summary-view"
import type { UsageWindowQuery } from "./window"

/** Summary facts share one database snapshot; labels are current best-effort decoration. */

export type {
  KeyLabel,
  UsageBreakdownRow,
  UsageCoverage,
  UsageLabelSets,
  UsageSeriesEntry,
  UsageSummary,
} from "./types"

import type { UsageLabelSets, UsageSummary } from "./types"

export interface UsageServiceDeps {
  readonly history: UsageHistoryRepository
  readonly recent: UsageRecentRepository
  readonly labels: () => Promise<UsageLabelSets>
  /** Account id to provider id, read from the warm catalog; absent means no provider cells. */
  readonly providers?: () => ReadonlyMap<string, string>
  readonly now: () => Date
  readonly exportMaxRows?: number
  readonly maxChartPoints?: number
  readonly breakdownMaxRows?: number
}

export interface UsageService {
  summary(query: UsageWindowQuery, filter?: UsageFilterQuery): Promise<AdminResult<UsageSummary>>
  /**
   * The CSV export at day x key x account x pool x model. The row cap is decided before any byte
   * is written: one past it is fetched, and seeing it answers 400.
   */
  exportCsv(query: UsageWindowQuery, filter?: UsageFilterQuery): Promise<AdminResult<UsageCsv>>
  /** Individual attempts, newest first — the feed the summary cannot answer for. */
  recent(query: RecentQuery): Promise<AdminResult<RecentView>>
}

export function createUsageService(deps: UsageServiceDeps): UsageService {
  return {
    summary: async (query, filter) => {
      const labels = await deps.labels()
      // Resolved from the label read above, which sits outside the snapshot below: the owner/tool
      // to key-id set is current labels, not the labels as of the facts' snapshot.
      const resolved = filter === undefined ? undefined : resolveUsageFilter(filter, labels.keys)
      return ok(
        await deps.history.withSnapshot((history, raw) =>
          readSummary({ ...deps, history, raw, labels }, query, resolved),
        ),
      )
    },

    exportCsv: async (query, filter) => {
      const labels = await deps.labels()
      const providers = deps.providers?.() ?? new Map<string, string>()
      const resolved = filter === undefined ? undefined : resolveUsageFilter(filter, labels.keys)
      const cap = deps.exportMaxRows ?? 50_000
      return deps.history.withSnapshot(async (history) => {
        const window = await resolveReadWindow(history, query)
        const rows = await history.exportRows(window, resolved, cap + 1)
        if (rows.length > cap) return invalid(overCapMessage(cap), "export_too_large")
        return ok({
          filename: exportFilename(window),
          body: renderUsageCsv(rows, { labels, providers }),
        })
      })
    },

    recent: async (query) => {
      // The label sets and the rows are independent, so they are issued together
      // rather than in sequence — the same reason the summary's aggregates are.
      const [labels, rows] = await Promise.all([
        deps.labels(),
        deps.recent.recent({
          limit: query.limit,
          outcomes: outcomesFor(query),
          requestId: query.requestId,
        }),
      ])

      // Projected once, not per row: a poll costs O(rows + labels).
      const names = { keys: keyNames(labels.keys), accounts: labels.accounts, pools: labels.pools }

      // `limit` is echoed as asked for, never as `rows.length`: a quiet router
      // returning four rows has truncated nothing, and a caption reading "at
      // most 4" would be describing the traffic rather than the page.
      return ok({
        attempts: rows.map((row) => toRecentAttemptView(row, names)),
        limit: query.limit,
      })
    },
  }
}

import type { UsageHistoryRepository, UsageRecentRepository } from "@multi-ai-router/db"
import { type AdminResult, ok } from "../admin/result"
import { outcomesFor, type RecentQuery, type RecentView, toRecentAttemptView } from "./recent"
import { readSummary } from "./summary"
import type { UsageWindowQuery } from "./window"

/** Summary facts share one database snapshot; labels are current best-effort decoration. */

export type {
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
  readonly now: () => Date
  readonly maxChartPoints?: number
  readonly breakdownMaxRows?: number
}

export interface UsageService {
  summary(query: UsageWindowQuery): Promise<AdminResult<UsageSummary>>
  /** Individual attempts, newest first — the feed the summary cannot answer for. */
  recent(query: RecentQuery): Promise<AdminResult<RecentView>>
}

export function createUsageService(deps: UsageServiceDeps): UsageService {
  return {
    summary: async (query) => {
      const labels = await deps.labels()
      return ok(
        await deps.history.withSnapshot((history, raw) =>
          readSummary({ ...deps, history, raw, labels }, query),
        ),
      )
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

      // `limit` is echoed as asked for, never as `rows.length`: a quiet router
      // returning four rows has truncated nothing, and a caption reading "at
      // most 4" would be describing the traffic rather than the page.
      return ok({
        attempts: rows.map((row) => toRecentAttemptView(row, labels)),
        limit: query.limit,
      })
    },
  }
}

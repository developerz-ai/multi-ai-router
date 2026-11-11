import type {
  UsageDimension,
  UsageFilter,
  UsageHistoryRepository,
  UsageKeyAttribution,
  UsageWindow,
} from "@multi-ai-router/db"
import { historyBreakdown } from "./group-reads"

type Totals = Awaited<ReturnType<UsageHistoryRepository["totals"]>>
type BreakdownRows = Awaited<ReturnType<UsageHistoryRepository["breakdown"]>>

/** What one summary needs from the folded history before any per-row decoration. */
export interface SummaryFacts {
  readonly totals: Totals
  /** One list per requested dimension, in request order, each at most `limit` rows. */
  readonly breakdowns: readonly BreakdownRows[]
}

export interface SummaryFactsInput {
  readonly window: UsageWindow
  readonly filter: UsageFilter
  readonly dimensions: readonly UsageDimension[]
  readonly limit: number
  readonly attribution: UsageKeyAttribution
}

/**
 * The seam for 07.7 / 10.11. `perDimensionFacts` issues seven statements (totals + one breakdown
 * per dimension), each rebuilding the folded `facts` source; `groupedFacts` asks the repository's
 * one `GROUPING SETS` statement (`summaryAggregates`) for the same answer. The repository's own
 * differential test holds the SQL to identical rows; `summary-facts.test.ts` holds the summary to
 * identical output.
 */
export type SummaryFactsReader = (input: SummaryFactsInput) => Promise<SummaryFacts>

export function perDimensionFacts(history: UsageHistoryRepository): SummaryFactsReader {
  return async ({ window, filter, dimensions, limit, attribution }) => {
    const [totals, breakdowns] = await Promise.all([
      history.totals(window, filter),
      Promise.all(
        dimensions.map((dimension) =>
          historyBreakdown(history, window, dimension, limit, filter, attribution),
        ),
      ),
    ])
    return { totals, breakdowns }
  }
}

/** One statement over one `facts` scan (`UsageHistoryRepository.summaryAggregates`). */
export function groupedFacts(history: UsageHistoryRepository): SummaryFactsReader {
  return async ({ window, filter, dimensions, limit, attribution }) => {
    const { totals, breakdowns } = await history.summaryAggregates(
      window,
      limit,
      filter,
      attribution,
    )
    return { totals, breakdowns: dimensions.map((dimension) => [...breakdowns[dimension]]) }
  }
}

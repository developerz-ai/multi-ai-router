import type { WireSummary } from "../src/lib/api/usage-wire"
import { ID } from "./fixture-ids"
import { AXIS, DAY, iso, LONG_LABEL } from "./fixture-time"
import type { WireTotals } from "./fixture-types"

// The usage summary `GET /usage?window=7d` answers during a geometry run. The rows exist to stress
// the cost columns of the keys and accounts tables; see `fixture.ts` for why.

const totals = (requests: number, metered: string, notional: string): WireTotals => ({
  requests,
  attempts: requests,
  errors: 0,
  tokensIn: requests * 4_096,
  tokensOut: requests * 1_024,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMetered: metered,
  costNotional: notional,
  unpriced: { attempts: 0, since: "2026-01-01" },
})

const row = (id: string, label: string, t: WireTotals, series: readonly number[]) => ({
  id,
  label,
  note: null,
  totals: t,
  latencyP50Ms: 240,
  latencyP95Ms: 900,
  routerOverheadP95Ms: 2,
  series,
})

/** A `byKey` row: the same shape plus `retired`, which only the key breakdown carries. */
const keyRow = (...args: Parameters<typeof row>) => ({ ...row(...args), retired: false })

/** `GET /usage?window=7d` — totals plus the two breakdowns the tables join on. */
export const usage: WireSummary = {
  coverage: {
    timeBasis: "event-time",
    requestsBasis: "terminal",
    historicalPrecision: "day",
    legacy: false,
    incomplete: false,
    bucketWidth: DAY,
    maxChartPoints: 240,
    retainedDetail: {
      from: iso(-7 * DAY),
      to: iso(0),
      attempts: 1_000,
      totalAttempts: 1_000,
      partial: false,
    },
    breakdown: { maxRows: 20, truncated: [] },
  },
  window: "7d",
  bucket: "day",
  from: iso(-7 * DAY),
  to: iso(0),
  totals: totals(1_000, "46532.67", "188.15"),
  latency: { p50Ms: 240, p95Ms: 900, routerOverheadP95Ms: 2, ttfbP95Ms: 420 },
  failures: { attempts: 1_000, errors: 0, partial: false, byOutcome: [] },
  axis: AXIS,
  series: AXIS.map((at, i) => ({ at, requests: 100 + i * 10, attempts: 100 + i * 10, errors: 0 })),
  byKey: [
    // The five-digit spend: wide enough that a cramped COST column would push it
    // into the neighbouring cell — the exact regression this gate exists for.
    keyRow(
      ID.keyBigSpender,
      "team-batch-pipeline",
      totals(600, "45678.90", "0"),
      [80, 90, 100, 95, 110, 105, 20],
    ),
    keyRow(ID.keyRevoked, "legacy-runner", totals(12, "34.56", "0"), [2, 2, 3, 1, 2, 1, 1]),
  ],
  byAccount: [
    row(
      ID.accSubscription,
      "claude-max-1",
      totals(412, "0", "88.40"),
      [50, 60, 58, 62, 61, 70, 51],
    ),
    // Non-zero metered AND notional on a STORED-badge row: the collision #62 was.
    row(
      ID.accApiKey,
      "anthropic-console-api",
      totals(588, "842.13", "96.25"),
      [90, 80, 85, 88, 79, 84, 82],
    ),
    row(ID.accLongLabel, LONG_LABEL, totals(64, "12.00", "3.50"), [9, 10, 8, 11, 9, 10, 7]),
  ],
  byPool: [],
  byModel: [],
  // The Usage page is not a geometry surface; these exist so the fixture keeps satisfying
  // `WireSummary` as the wire grows, and name one owner and one unassigned tool bucket.
  byOwner: [
    {
      ...row("service/ci", "ci", totals(600, "45678.90", "0"), [80, 90, 100, 95, 110, 105, 20]),
      ownerKind: "service" as const,
    },
  ],
  byTool: [
    {
      ...row("unused", "unused", totals(12, "34.56", "0"), [2, 2, 3, 1, 2, 1, 1]),
      id: null,
      label: null,
      note: "unassigned" as const,
    },
  ],
}

import type { UsageOutcome } from "@multi-ai-router/core"
import type { FailureCount } from "../failure-classes"
import { request } from "./client"
import {
  isCustomRange,
  type UsageBreakdownRow,
  type UsageCoverage,
  type UsageFailureSplit,
  type UsageRange,
  type UsageSummary,
  type UsageTotals,
  type UsageWindowLabel,
} from "./usage"

// ------------------------------------------------------------------ the wire

/** Exactly what `GET /api/admin/usage` returns. Parsed into the types above. */
interface WireTotals {
  readonly requests: number
  readonly attempts: number
  readonly errors: number
  readonly tokensIn: number
  readonly tokensOut: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costMetered: string
  readonly costNotional: string
}

interface WireRow {
  readonly id: string | null
  readonly label: string | null
  readonly note: "deleted" | "none" | null
  readonly totals: WireTotals
  readonly latencyP50Ms: number | null
  readonly latencyP95Ms: number | null
  readonly routerOverheadP95Ms: number | null
  readonly series: readonly number[]
}

interface WireSummary {
  readonly coverage: UsageCoverage
  readonly window: string
  readonly bucket: "hour" | "day"
  readonly from: string
  readonly to: string
  readonly totals: WireTotals
  readonly latency: {
    readonly p50Ms: number | null
    readonly p95Ms: number | null
    readonly routerOverheadP95Ms: number | null
    readonly ttfbP95Ms: number | null
  }
  readonly failures: {
    readonly attempts: number
    readonly errors: number
    readonly partial: boolean
    readonly byOutcome: readonly { readonly outcome: UsageOutcome; readonly attempts: number }[]
  }
  readonly axis: readonly string[]
  readonly series: readonly {
    readonly at: string
    readonly requests: number
    readonly attempts: number
    readonly errors: number
  }[]
  readonly byKey: readonly WireRow[]
  readonly byAccount: readonly WireRow[]
  readonly byPool: readonly WireRow[]
  readonly byModel: readonly WireRow[]
}

export async function fetchUsageSummary(range: UsageRange): Promise<UsageSummary> {
  const query = isCustomRange(range) ? { from: range.from, to: range.to } : { window: range }
  const wire = await request<WireSummary>({ method: "GET", path: "/usage", query })

  return {
    // The server is the one source of truth for what it actually resolved the request to — a
    // custom range comes back labelled `"custom"`, a named window echoes its own name.
    window: wire.window as UsageWindowLabel,
    bucket: wire.bucket,
    from: wire.from,
    to: wire.to,
    totals: {
      ...parseTotals(wire.totals),
      // Null carried through, never `?? 0`: the server's null means "nothing measured", and the
      // render's contract is a dash for that — "0 ms" on the overhead tile is a perfect result.
      latencyP50Ms: wire.latency.p50Ms,
      latencyP95Ms: wire.latency.p95Ms,
      routerOverheadP95Ms: wire.latency.routerOverheadP95Ms,
      ttfbP95Ms: wire.latency.ttfbP95Ms,
    },
    failures: parseFailures(wire.failures),
    coverage: wire.coverage,
    series: wire.series.map((point) => ({
      at: point.at,
      requests: point.requests,
      attempts: point.attempts,
      errors: point.errors,
    })),
    byKey: wire.byKey.map(toRow),
    byAccount: wire.byAccount.map(toRow),
    byPool: wire.byPool.map(toRow),
    byModel: wire.byModel.map(toRow),
  }
}

/**
 * Narrows the split to what it can actually contain.
 *
 * `success` is dropped rather than trusted to be absent: the server filters it,
 * and one filter at the edge is cheaper than a `success` branch in every
 * consumer of the type. `errors` is recomputed from the rows that survived, so
 * the headline figure and the rows under it can never disagree.
 */
function parseFailures(failures: WireSummary["failures"]): UsageFailureSplit {
  const byOutcome = failures.byOutcome.filter(
    (row): row is FailureCount => row.outcome !== "success",
  )
  return {
    attempts: failures.attempts,
    errors: byOutcome.reduce((sum, row) => sum + row.attempts, 0),
    partial: failures.partial,
    byOutcome,
  }
}

function parseTotals(
  totals: WireTotals,
): Omit<UsageTotals, "latencyP50Ms" | "latencyP95Ms" | "routerOverheadP95Ms" | "ttfbP95Ms"> {
  return {
    requests: totals.requests,
    attempts: totals.attempts,
    errors: totals.errors,
    tokensIn: totals.tokensIn,
    tokensOut: totals.tokensOut,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costMetered: Number(totals.costMetered),
    costNotional: Number(totals.costNotional),
  }
}

/**
 * A missing label is rendered, never hidden. `null` becomes an explicit word so a table cell is
 * never blank and a reader never has to guess whether a row is broken or simply unattributed.
 */
function toRow(row: WireRow): UsageBreakdownRow {
  return {
    id: row.id ?? `none-${row.note ?? "unknown"}`,
    label: row.label ?? (row.note === "deleted" ? "(deleted)" : "(none)"),
    note: noteFor(row),
    series: row.series,
    totals: {
      ...parseTotals(row.totals),
      // Null carried through — see `fetchUsageSummary`. A quiet row renders a dash, not "0 ms".
      latencyP50Ms: row.latencyP50Ms,
      latencyP95Ms: row.latencyP95Ms,
      routerOverheadP95Ms: row.routerOverheadP95Ms,
      // Not tracked per breakdown row on the wire, only for the summary as a whole — a per-row
      // TTFT would need a percentile scan per key/account/pool/model, which nobody has asked
      // for. Null, because "not tracked" is precisely what null means here; a zero would claim
      // this row's first byte arrived instantly.
      ttfbP95Ms: null,
    },
  }
}

function noteFor(row: WireRow): string {
  if (row.note === "deleted") return "no longer exists"
  if (row.note === "none") return "not attributed"
  return ""
}

import { type CsvCell, csvLine, verbatim } from "../usage-read/csv"
import type { ReportMeasures, WeeklyReport } from "./types"

/**
 * The weekly report's CSV attachment (issue #229): everything #227 stored, rendered to one CSV.
 * Pure and payload-only — delivery never re-reads live state, so key names and pool names appear
 * exactly where the stored payload carries them (the overflow lines) and are never back-filled
 * from live key labels. No account label exists anywhere in the payload, so none can appear here.
 *
 * Reuses the usage export's RFC 4180 writer, formula guard included: owner and key names are
 * operator-chosen text.
 */

const HEADER = [
  "section",
  "owner",
  "owner_kind",
  "tool",
  "key_name",
  "pool_name",
  "provider",
  "model",
  "requests",
  "tokens_in",
  "tokens_out",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost_metered",
  "cost_notional",
  "unpriced_attempts",
  "attempts",
  "overflow_attempts",
  "overflow_share",
  "note",
] as const

type Cells = Partial<Record<(typeof HEADER)[number], CsvCell>>

const line = (cells: Cells): string => csvLine(HEADER.map((name) => cells[name] ?? null))

/** The eight measure columns; money stays the exact `numeric(24,6)` string, hence `verbatim`. */
function measures(m: ReportMeasures): Cells {
  return {
    requests: m.requests,
    tokens_in: m.tokensIn,
    tokens_out: m.tokensOut,
    cache_read_tokens: m.cacheReadTokens,
    cache_write_tokens: m.cacheWriteTokens,
    cost_metered: verbatim(m.costMetered),
    cost_notional: verbatim(m.costNotional),
    unpriced_attempts: m.unpricedAttempts,
  }
}

/** `usage-report-<monday>.csv`; the Monday is already validated by the period parse. */
export function reportCsvFilename(periodStart: string): string {
  return `usage-report-${periodStart}.csv`
}

export function renderReportCsv(report: WeeklyReport): string {
  let out = csvLine(HEADER)
  const sections: readonly [string, WeeklyReport["sections"]["people"]][] = [
    ["people", report.sections.people],
    ["services", report.sections.services],
    ["unknown_kind", report.sections.unknownKind],
  ]
  for (const [name, section] of sections) {
    for (const l of section.lines) {
      out += line({
        section: name,
        owner: l.owner,
        owner_kind: l.ownerKind,
        tool: l.tool,
        ...measures(l),
      })
    }
    out += line({ section: `${name}_total`, ...measures(section.totals) })
  }
  for (const [name, bucket] of [
    ["unassigned", report.buckets.unassigned],
    ["deleted", report.buckets.deleted],
    ["none", report.buckets.none],
  ] as const) {
    out += line({ section: "bucket", owner: name, ...measures(bucket) })
  }
  out += line({ section: "total", ...measures(report.totals) })
  for (const m of report.topModels) {
    out += line({ section: "model", model: m.model, ...measures(m) })
  }
  for (const o of report.overflow) {
    out += line({
      section: "overflow",
      owner: o.owner,
      owner_kind: o.ownerKind,
      tool: o.tool,
      key_name: o.keyName,
      pool_name: o.poolName,
      provider: o.provider,
      attempts: o.attempts,
      overflow_attempts: o.overflowAttempts,
      overflow_share: verbatim(o.share.toFixed(4)),
    })
  }
  for (const c of report.caveats) {
    out += line({ section: "caveat", note: c.text })
  }
  return out
}

import type { UsageWeekRow } from "@multi-ai-router/db"
import { reportCaveats, reportCoverage } from "./caveats"
import {
  type Accumulator,
  addAccumulator,
  addRow,
  emptyAccumulator,
  tokensOf,
  toMeasures,
} from "./measures"
import { overflowShares } from "./overflow"
import { isoDay } from "./period"
import type {
  ReportKeyLabel,
  ReportLine,
  ReportModelLine,
  ReportPeriod,
  ReportPool,
  ReportSection,
  WeeklyReport,
} from "./types"

/**
 * The weekly report as a pure function: rows, key labels, pools and the period in; the report out.
 * No database, no clock, no environment, so every figure is hand-checkable from a fixture.
 *
 * Every row lands in exactly one place: an owner section line (people, services, or unknown-kind
 * for an owner with no kind), or one of the three buckets (`unassigned`, `deleted`, `none`). The
 * totals are accumulated from the rows directly, not from the parts, so "sections plus buckets
 * equal the totals" is a real check and not an identity.
 *
 * Owners fold on (owner kind, owner), the same rule as the usage breakdown: a person and a service
 * sharing a slug are two lines in two sections. A tombstoned key keeps its attribution, so the
 * `retired` flag on a label changes nothing here.
 */

/**
 * Part of the report contract, not tuning: the stored payload is immutable and delivery renders it
 * as is, so the cut is fixed at ten rather than moved by an env var that would make two weeks'
 * reports incomparable. A week with more models than this is read in full (the week read is
 * bounded by `USAGE_REPORT_MAX_ROWS`) and only the top ten by tokens are kept here.
 */
const TOP_MODELS = 10

const MEASURE_LABELS: WeeklyReport["measureLabels"] = {
  requests: "Requests",
  tokensIn: "Input tokens",
  tokensOut: "Output tokens",
  cacheReadTokens: "Cache read tokens",
  cacheWriteTokens: "Cache write tokens",
  costMetered: "METERED $ (billed per token)",
  costNotional:
    "NOTIONAL $ (list-price attribution on flat-fee subscription accounts, not spend; never added to METERED)",
  unpricedAttempts: "Unpriced attempts (not measured when null)",
}

interface Line {
  readonly owner: string
  readonly ownerKind: ReportLine["ownerKind"]
  readonly tool: string | null
  readonly acc: Accumulator
}

export function buildWeeklyReport(
  rows: readonly UsageWeekRow[],
  labels: ReadonlyMap<string, ReportKeyLabel>,
  pools: readonly ReportPool[],
  period: ReportPeriod,
): WeeklyReport {
  const coverage = reportCoverage(period)
  // Measured when any row says so; an empty week falls back to what the measure's start implies.
  const measured =
    rows.length > 0
      ? rows.some((row) => row.unpricedAttempts !== null)
      : coverage.unpricedMeasured !== "none"
  const fresh = () => emptyAccumulator(measured)

  const totals = fresh()
  const buckets = { unassigned: fresh(), deleted: fresh(), none: fresh() }
  const lines = {
    person: new Map<string, Line>(),
    service: new Map<string, Line>(),
    unknown: new Map<string, Line>(),
  }
  const models = new Map<string | null, Accumulator>()
  let measuredAttempts = 0

  for (const row of rows) {
    measuredAttempts += row.measuredAttempts
    addRow(totals, row)
    addRow(models.get(row.model) ?? setDefault(models, row.model, fresh()), row)

    if (row.apiKeyId === null) {
      addRow(buckets.none, row)
      continue
    }
    const label = labels.get(row.apiKeyId)
    if (label === undefined) {
      addRow(buckets.deleted, row)
      continue
    }
    if (label.owner === null) {
      addRow(buckets.unassigned, row)
      continue
    }
    const section = lines[label.ownerKind ?? "unknown"]
    // NUL cannot occur in a slug, so an owner and a tool never run together into another pair.
    const key = `${label.owner}\u0000${label.tool ?? "\u0001"}`
    const line =
      section.get(key) ??
      setDefault(section, key, {
        owner: label.owner,
        ownerKind: label.ownerKind,
        tool: label.tool,
        acc: fresh(),
      })
    addRow(line.acc, row)
  }

  return {
    version: 1,
    period: { start: isoDay(period.start), end: isoDay(period.end) },
    generatedAt: period.generatedAt.toISOString(),
    coverage,
    measureLabels: MEASURE_LABELS,
    totals: toMeasures(totals),
    sections: {
      people: section(lines.person, fresh),
      services: section(lines.service, fresh),
      unknownKind: section(lines.unknown, fresh),
    },
    buckets: {
      unassigned: toMeasures(buckets.unassigned),
      deleted: toMeasures(buckets.deleted),
      none: toMeasures(buckets.none),
    },
    topModels: topModels(models),
    overflow: overflowShares(rows, labels, pools),
    caveats: reportCaveats({
      period,
      coverage,
      unpriced: toMeasures(totals).unpricedAttempts,
      measuredAttempts,
    }),
  }
}

function setDefault<K, V>(map: Map<K, V>, key: K, value: V): V {
  map.set(key, value)
  return value
}

function section(lines: ReadonlyMap<string, Line>, fresh: () => Accumulator): ReportSection {
  const sum = fresh()
  const ordered = [...lines.values()].sort(
    (a, b) =>
      tokensOf(b.acc) - tokensOf(a.acc) ||
      a.owner.localeCompare(b.owner) ||
      (a.tool ?? "").localeCompare(b.tool ?? ""),
  )
  for (const line of ordered) addAccumulator(sum, line.acc)
  return {
    lines: ordered.map((line) => ({
      owner: line.owner,
      ownerKind: line.ownerKind,
      tool: line.tool,
      ...toMeasures(line.acc),
    })),
    totals: toMeasures(sum),
  }
}

function topModels(models: ReadonlyMap<string | null, Accumulator>): ReportModelLine[] {
  return [...models]
    .sort(
      ([modelA, a], [modelB, b]) =>
        tokensOf(b) - tokensOf(a) || (modelA ?? "").localeCompare(modelB ?? ""),
    )
    .slice(0, TOP_MODELS)
    .map(([model, acc]) => ({ model, ...toMeasures(acc) }))
}

import type { UsageWeekRow } from "@multi-ai-router/db"
import type { ReportMeasures } from "./types"

/**
 * Exact accumulation of a report line's measures.
 *
 * Money is held as integer micro-units (the rollup's `numeric(24,6)` has six decimals) and
 * rendered back to six places, so sections, buckets and totals add up to the last digit; summing
 * float8 would make "sections plus buckets equal the totals" flaky at the sixth decimal.
 */
export interface Accumulator {
  requests: number
  tokensIn: number
  tokensOut: number
  metered: bigint
  notional: bigint
  /** `null` while nothing measured has been added: unmeasured, never 0. */
  unpriced: number | null
}

export function emptyAccumulator(unpricedMeasured: boolean): Accumulator {
  return {
    requests: 0,
    tokensIn: 0,
    tokensOut: 0,
    metered: 0n,
    notional: 0n,
    unpriced: unpricedMeasured ? 0 : null,
  }
}

const MICROS = 1_000_000n

/** `numeric(24,6)` text to micro-units. Tolerates fewer than six decimals and a leading minus. */
export function toMicros(value: string): bigint {
  const negative = value.startsWith("-")
  const [whole = "0", fraction = ""] = value.replace("-", "").split(".")
  const micros = BigInt(whole || "0") * MICROS + BigInt(fraction.padEnd(6, "0").slice(0, 6))
  return negative ? -micros : micros
}

export function fromMicros(value: bigint): string {
  const negative = value < 0n
  const magnitude = negative ? -value : value
  const fraction = (magnitude % MICROS).toString().padStart(6, "0")
  return `${negative ? "-" : ""}${magnitude / MICROS}.${fraction}`
}

export function addRow(acc: Accumulator, row: UsageWeekRow): void {
  acc.requests += row.requests
  acc.tokensIn += row.tokensIn
  acc.tokensOut += row.tokensOut
  acc.metered += toMicros(row.costMetered)
  acc.notional += toMicros(row.costNotional)
  if (row.unpricedAttempts !== null) acc.unpriced = (acc.unpriced ?? 0) + row.unpricedAttempts
}

export function addAccumulator(into: Accumulator, from: Accumulator): void {
  into.requests += from.requests
  into.tokensIn += from.tokensIn
  into.tokensOut += from.tokensOut
  into.metered += from.metered
  into.notional += from.notional
  if (from.unpriced !== null) into.unpriced = (into.unpriced ?? 0) + from.unpriced
}

export function toMeasures(acc: Accumulator): ReportMeasures {
  return {
    requests: acc.requests,
    tokensIn: acc.tokensIn,
    tokensOut: acc.tokensOut,
    costMetered: fromMicros(acc.metered),
    costNotional: fromMicros(acc.notional),
    unpricedAttempts: acc.unpriced,
  }
}

/** Ranking key: total tokens. */
export function tokensOf(acc: Accumulator): number {
  return acc.tokensIn + acc.tokensOut
}

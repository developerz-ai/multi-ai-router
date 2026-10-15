import { parse } from "csv-parse/sync"

/** Parsed export rows keyed by header. A real RFC 4180 parser, not one that agrees with the writer. */
export const records = (text: string) => parse(text, { columns: true }) as Record<string, string>[]

/** Integer micro-dollars from a numeric(24,6) string: float sums would not compare. */
export const micros = (value: string): bigint => {
  const negative = value.startsWith("-")
  const [whole = "0", frac = ""] = value.replace("-", "").split(".")
  const n = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6))
  return negative ? -n : n
}
export const sum = (rows: Record<string, string>[], column: string) =>
  rows.reduce((n, row) => n + Number(row[column] ?? 0), 0)
export const sumMicros = (rows: Record<string, string>[], column: string) =>
  rows.reduce((n, row) => n + micros(row[column] ?? "0"), 0n)

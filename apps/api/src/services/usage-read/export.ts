import type { UsageExportRow } from "@multi-ai-router/db"
import { type CsvCell, csvLine, verbatim } from "./csv"
import type { UsageLabelSets } from "./types"
import type { ResolvedWindow } from "./window"

/**
 * The usage CSV export (issue #226): column order, cell derivation, filename and cap message.
 * Pure: the label maps and the rows are injected, so none of it needs a database.
 *
 * Rows carry no ids and no coverage signal. Two deleted accounts, or two keys with no tombstone,
 * on the same day/pool/model read identically (the summary keeps those apart under their id), and
 * the file does not say whether the window reached legacy or pending history. Both are stated in
 * docs/idea/08-observability.md rather than invented here, because the header is pinned.
 *
 * Absent values are empty cells: no `#unassigned` sentinel, no `unknown` kind.
 */
export const USAGE_EXPORT_HEADER = [
  "day",
  "owner",
  "owner_kind",
  "tool",
  "key_name",
  "key_prefix",
  "pool",
  "account",
  "provider",
  "model",
  "requests",
  "attempts",
  "errors",
  "tokens_in",
  "tokens_out",
  "cache_read",
  "cache_write",
  "cost_metered_usd",
  "cost_notional_usd",
  "unpriced_attempts",
] as const

export interface UsageCsv {
  readonly filename: string
  /** Rendered a bounded chunk per pull, yielding to the event loop between chunks. */
  readonly body: ReadableStream<Uint8Array>
}

/** Row ceiling per chunk. */
export const USAGE_EXPORT_CHUNK_ROWS = 1_000
/**
 * Rendered-size cut per chunk, in characters (UTF-16 units, so non-ASCII text encodes larger).
 * Wide rows (long, quote-filled models) cost more to render: with a row-only cut, 1000 such rows
 * took ~30 ms per pull on the shared event loop; at 32K characters a pull stays at a few ms.
 */
export const USAGE_EXPORT_CHUNK_CHARS = 32 * 1024

/** What turns the ids on a row into the words the file prints. */
export interface ExportSubjects {
  readonly labels: UsageLabelSets
  /** Account id to provider id, from the catalog snapshot. Never an account record. */
  readonly providers: ReadonlyMap<string, string>
}

export function exportCells(row: UsageExportRow, subjects: ExportSubjects): CsvCell[] {
  const key = row.apiKeyId === null ? undefined : subjects.labels.keys.get(row.apiKeyId)
  const account = row.accountId ?? undefined
  return [
    verbatim(row.day),
    key?.owner,
    key?.ownerKind,
    key?.tool,
    key?.name,
    key?.prefix,
    row.poolId === null ? undefined : subjects.labels.pools.get(row.poolId),
    account === undefined ? undefined : subjects.labels.accounts.get(account),
    account === undefined ? undefined : subjects.providers.get(account),
    row.model,
    row.requests,
    row.attempts,
    row.errors,
    row.tokensIn,
    row.tokensOut,
    row.cacheReadTokens,
    row.cacheWriteTokens,
    verbatim(row.costMetered),
    verbatim(row.costNotional),
    row.unpricedAttempts,
  ]
}

/** The whole file in one pass: the reference the chunked form must equal, and small-input use. */
export function renderUsageCsv(rows: readonly UsageExportRow[], subjects: ExportSubjects): string {
  return (
    csvLine([...USAGE_EXPORT_HEADER]) +
    rows.map((row) => csvLine(exportCells(row, subjects))).join("")
  )
}

/**
 * The file as strings, each cut after the row that takes it past {@link USAGE_EXPORT_CHUNK_CHARS}
 * (or {@link USAGE_EXPORT_CHUNK_ROWS} rows); the first carries the header.
 */
export function* usageCsvChunks(
  rows: readonly UsageExportRow[],
  subjects: ExportSubjects,
  size = USAGE_EXPORT_CHUNK_ROWS,
): Generator<string> {
  let chunk = csvLine([...USAGE_EXPORT_HEADER])
  let inChunk = 0
  for (const row of rows) {
    chunk += csvLine(exportCells(row, subjects))
    inChunk += 1
    if (inChunk >= size || chunk.length >= USAGE_EXPORT_CHUNK_CHARS) {
      yield chunk
      chunk = ""
      inChunk = 0
    }
  }
  if (chunk !== "") yield chunk
}

/**
 * The body as a byte stream. Each `pull()` first yields to the event loop, then renders one
 * bounded chunk, so the render is split into short pieces with the loop free between them rather
 * than held for the whole file (non-negotiable 8). It is not zero-cost: a chunk still takes a few
 * milliseconds of the shared loop. The row cap was decided before this is built, so nothing here
 * can turn into a late error.
 */
export function usageCsvStream(
  rows: readonly UsageExportRow[],
  subjects: ExportSubjects,
): ReadableStream<Uint8Array> {
  const chunks = usageCsvChunks(rows, subjects)
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      const next = chunks.next()
      if (next.done === true) controller.close()
      else controller.enqueue(encoder.encode(next.value))
    },
  })
}

/**
 * `usage-<window>-<from>-<to>.csv`, every character in `[A-Za-z0-9._-]`: a custom ISO window
 * would otherwise put `:` into a header value.
 */
export function exportFilename(window: ResolvedWindow): string {
  const stamp = (at: Date) =>
    at
      .toISOString()
      .replace(/\.\d+Z$/, "Z")
      .replaceAll(/[-:]/g, "")
  return `usage-${window.label}-${stamp(window.from)}-${stamp(window.to)}.csv`
}

export function overCapMessage(cap: number): string {
  return `The export has more than ${cap} rows, the USAGE_EXPORT_MAX_ROWS cap. Narrow the window or add filters.`
}

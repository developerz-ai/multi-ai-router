/**
 * A small RFC 4180 writer for the usage export, with the spreadsheet formula guard built in.
 *
 * **Text is guarded by default.** A plain `string` cell is treated as text: a leading `=`, `+`,
 * `-`, `@`, tab or CR gets a leading apostrophe so a spreadsheet shows it instead of evaluating
 * it. The model name is chosen by any router-key holder, so the guard belongs to the writer, not
 * to the one column someone remembered. The guard runs before quoting, so the apostrophe sits
 * inside the quotes.
 *
 * What is not text must say so: a number is never guarded (it is a non-negative count or cost),
 * and a {@link verbatim} cell (a date, a fixed-point decimal) skips the guard but is still quoted
 * when it has to be.
 */

export const CSV_EOL = "\r\n"

const FORMULA_LEADS = new Set(["=", "+", "-", "@", "\t", "\r"])

export interface Verbatim {
  readonly verbatim: string
}
export type CsvCell = string | number | Verbatim | null | undefined

/** Marks a value the caller built itself (an ISO date, a numeric(24,6) string) as not text. */
export function verbatim(value: string): Verbatim {
  return { verbatim: value }
}

export function guardFormula(text: string): string {
  const lead = text[0]
  return lead !== undefined && FORMULA_LEADS.has(lead) ? `'${text}` : text
}

function quote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function render(cell: CsvCell): string {
  if (cell === null || cell === undefined) return ""
  if (typeof cell === "number") return String(cell)
  if (typeof cell === "string") return quote(guardFormula(cell))
  return quote(cell.verbatim)
}

/** One record, CRLF-terminated. */
export function csvLine(cells: readonly CsvCell[]): string {
  return cells.map(render).join(",") + CSV_EOL
}

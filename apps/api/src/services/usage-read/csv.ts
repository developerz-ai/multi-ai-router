/**
 * A small RFC 4180 writer for the usage export, with the spreadsheet formula guard built in.
 *
 * **Text is guarded by default.** A plain `string` cell is treated as text. A leading `=`, `+`,
 * `-`, `@`, tab or CR (or their full-width forms, after any leading spaces) gets a leading
 * apostrophe, so a spreadsheet shows it instead of evaluating it. The model name is chosen by any
 * router-key holder, so the guard belongs to the writer, not to the one column someone remembered.
 *
 * Spreadsheets in comma-decimal locales split on `;`, and some on tab, so the same lead right
 * after a `;` or a tab (with spaces or quotes between) is neutralised too. A CR or LF inside a
 * cell would end the record under a naive split and start the next "row" with a live formula, so
 * text cells have each CR, LF or CRLF replaced by one space before guarding. No model, label or
 * name legitimately contains a line break. The guard runs before quoting, so the apostrophe sits
 * inside the quotes.
 *
 * What is not text must say so: a number is never guarded (it is a non-negative count or cost),
 * and a {@link verbatim} cell (a date, a fixed-point decimal) skips the guard but is still quoted
 * when it has to be.
 */

export const CSV_EOL = "\r\n"

// = + - @ tab CR, plus their full-width forms (a spreadsheet may fold them to the ASCII ones).
const LEAD = "[=+\\-@\\t\\r\uFF1D\uFF0B\uFF0D\uFF20]"
const STARTS_FORMULA = new RegExp(`^ *${LEAD}`)
// ';' (the list separator in comma-decimal locales) and tab can split one cell into several.
const AFTER_SEPARATOR = new RegExp(`([;\\t][ "]*)(?=${LEAD})`, "g")

export interface Verbatim {
  readonly verbatim: string
}
export type CsvCell = string | number | Verbatim | null | undefined

/** Marks a value the caller built itself (an ISO date, a numeric(24,6) string) as not text. */
export function verbatim(value: string): Verbatim {
  return { verbatim: value }
}

export function guardFormula(text: string): string {
  const flat = text.replace(/\r\n|[\r\n]/g, " ")
  const lead = STARTS_FORMULA.test(flat) ? `'${flat}` : flat
  return lead.replace(AFTER_SEPARATOR, "$1'")
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

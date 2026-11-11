/**
 * A `<input type="number">` box's text as the number the browser accepted.
 *
 * `Number`, never `Number.parseInt`: a number box accepts `1e3`, and `parseInt` reads that as `1`
 * — a ceiling of a thousand saved as one. Empty or unreadable is `null`; the caller decides what
 * an empty box means.
 */
export function readNumberInput(raw: string): number | null {
  const text = raw.trim()
  if (text === "") return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

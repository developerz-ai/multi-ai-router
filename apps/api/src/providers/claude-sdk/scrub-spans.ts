/**
 * Removing a delimited span from a prompt in one pass.
 *
 * These are what `OPEN[\s\S]*?CLOSE` says, minus its cost. A lazy regex re-scans to the end of the
 * text for every opener whose close never comes, so a system prompt of repeated unclosed openers
 * took 4.6 s of event loop at 266 KB — any key holder could stall every stream on the replica. Here
 * the first opener with no close ends the search: no later opener has one either.
 */

export interface SpanRule {
  readonly open: string
  readonly close: string
  /**
   * What the span swallows after its close: `line` is the rest of that line and the newlines behind
   * it (and the span does not match without one), `newlines` any run of them, `newline` at most one.
   */
  readonly tail: "line" | "newlines" | "newline"
  /** Also swallow one newline standing directly before the opener. */
  readonly leadingNewline?: boolean
  readonly replacement: string
}

export function replaceSpans(text: string, rule: SpanRule): string {
  const parts: string[] = []
  let kept = 0
  for (;;) {
    const open = text.indexOf(rule.open, kept)
    if (open === -1) break
    const close = text.indexOf(rule.close, open + rule.open.length)
    if (close === -1) break
    const end = spanEnd(text, close + rule.close.length, rule.tail)
    if (end === -1) break
    const start =
      rule.leadingNewline === true && open > kept && text[open - 1] === "\n" ? open - 1 : open
    parts.push(text.slice(kept, start), rule.replacement)
    kept = end
  }
  return kept === 0 ? text : parts.join("") + text.slice(kept)
}

/**
 * Every line carrying `opener` and, after it, `marker`: from the opener through the newlines that
 * end the line. A last line with no newline is left standing.
 */
export function removeLines(text: string, opener: RegExp, marker: string): string {
  const parts: string[] = []
  const search = new RegExp(opener.source, "g")
  let kept = 0
  for (let match = search.exec(text); match !== null; match = search.exec(text)) {
    const after = match.index + match[0].length
    const lineEnd = text.indexOf("\n", after)
    if (lineEnd === -1) break
    if (!text.slice(after, lineEnd).includes(marker)) {
      // What follows a later opener on this line is a suffix of what was just searched.
      search.lastIndex = lineEnd
      continue
    }
    parts.push(text.slice(kept, match.index))
    kept = pastNewlines(text, lineEnd)
    search.lastIndex = kept
  }
  return kept === 0 ? text : parts.join("") + text.slice(kept)
}

function spanEnd(text: string, from: number, tail: SpanRule["tail"]): number {
  if (tail === "newline") return text[from] === "\n" ? from + 1 : from
  if (tail === "newlines") return pastNewlines(text, from)
  const lineEnd = text.indexOf("\n", from)
  return lineEnd === -1 ? -1 : pastNewlines(text, lineEnd)
}

function pastNewlines(text: string, from: number): number {
  let at = from
  while (text[at] === "\n") at += 1
  return at
}

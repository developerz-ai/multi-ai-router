import type { ByteSpan } from "./scanner-types"
import { PLAIN, STRING_CLASS } from "./string-validation"

/**
 * The top-level members of a JSON object, by byte span, without parsing the object.
 *
 * A passthrough edit touches one small member of a body that may be megabytes of transcript. Parsing
 * and re-serializing the whole body to do it cost ~6 ms per MB and rewrote bytes nobody asked about:
 * a number past 2^53 changed value, `1.0` became `1`. Here the rest of the body is stepped over and
 * copied. Admission already validated the grammar (`scanner.ts`); bytes that are not an object
 * answer `null` and are left to the upstream.
 */
export interface TopLevel {
  /** Index of the opening brace. */
  readonly open: number
  readonly empty: boolean
  /** The value span of each wanted key, the last one when a key repeats (as `JSON.parse` reads it). */
  readonly values: ReadonlyMap<string, ByteSpan>
}

const QUOTE = 0x22
const BACKSLASH = 0x5c
const COMMA = 0x2c
const COLON = 0x3a

export function topLevelMembers(bytes: Uint8Array, wanted: readonly string[]): TopLevel | null {
  const n = bytes.length
  const values = new Map<string, ByteSpan>()
  const open = afterSpace(bytes, 0)
  if (bytes[open] !== 0x7b) return null
  let i = afterSpace(bytes, open + 1)
  if (bytes[i] === 0x7d) return { open, empty: true, values }
  while (i < n) {
    if (bytes[i] !== QUOTE) return null
    const keyEnd = stringEnd(bytes, i)
    const key = keyOf(bytes, i, keyEnd)
    i = afterSpace(bytes, keyEnd)
    if (bytes[i] !== COLON) return null
    const start = afterSpace(bytes, i + 1)
    const end = valueEnd(bytes, start)
    if (key !== null && wanted.includes(key)) values.set(key, { start, end })
    i = afterSpace(bytes, end)
    if (bytes[i] === 0x7d) return { open, empty: false, values }
    if (bytes[i] !== COMMA) return null
    i = afterSpace(bytes, i + 1)
  }
  return null
}

/** A member's value, parsed; `undefined` when the body does not state it. */
export function memberValue(bytes: Uint8Array, span: ByteSpan | undefined): unknown {
  if (span === undefined) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(span.start, span.end)))
  } catch {
    return undefined
  }
}

/** The body with one member's value replaced, or the member added first when it is not stated. */
export function withMember(
  bytes: Uint8Array,
  top: TopLevel,
  key: string,
  value: unknown,
): Uint8Array {
  const text = JSON.stringify(value)
  const span = top.values.get(key)
  if (span !== undefined) return replaceSpan(bytes, span, text)
  const at = { start: top.open + 1, end: top.open + 1 }
  return replaceSpan(bytes, at, `${JSON.stringify(key)}:${text}${top.empty ? "" : ","}`)
}

/** Everything around the span is copied verbatim. */
export function replaceSpan(bytes: Uint8Array, span: ByteSpan, text: string): Uint8Array {
  const replacement = new TextEncoder().encode(text)
  const out = new Uint8Array(bytes.length - (span.end - span.start) + replacement.length)
  out.set(bytes.subarray(0, span.start), 0)
  out.set(replacement, span.start)
  out.set(bytes.subarray(span.end), span.start + replacement.length)
  return out
}

function afterSpace(bytes: Uint8Array, from: number): number {
  let i = from
  while (i < bytes.length) {
    const b = bytes[i]
    if (b !== 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) break
    i++
  }
  return i
}

/** Just past the closing quote of the string opening at `at`. */
function stringEnd(bytes: Uint8Array, at: number): number {
  const n = bytes.length
  let i = at + 1
  while (i < n) {
    while (i < n && STRING_CLASS[bytes[i] ?? 0] === PLAIN) i++
    if (bytes[i] === QUOTE) return i + 1
    i += bytes[i] === BACKSLASH ? 2 : 1
  }
  return n
}

/** Just past the value starting at `at`: a string, a container, or a bare literal. */
function valueEnd(bytes: Uint8Array, at: number): number {
  const n = bytes.length
  if (bytes[at] === QUOTE) return stringEnd(bytes, at)
  let depth = 0
  let i = at
  while (i < n) {
    const b = bytes[i]
    if (b === QUOTE) {
      i = stringEnd(bytes, i)
      continue
    }
    if (b === 0x7b || b === 0x5b) depth++
    else if (b === 0x7d || b === 0x5d) {
      if (depth === 0) return i
      depth--
      if (depth === 0) return i + 1
    } else if (depth === 0 && (b === COMMA || b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d))
      return i
    i++
  }
  return n
}

function keyOf(bytes: Uint8Array, start: number, end: number): string | null {
  try {
    const key: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(start, end)))
    return typeof key === "string" ? key : null
  } catch {
    return null
  }
}

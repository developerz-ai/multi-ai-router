/**
 * The canonical form of a JSON value, built as its bytes arrive.
 *
 * A slot's room must be what its value costs, not what its encoding spent: an escaped repeat of
 * a literal slot holds the same value in a longer spelling, and the room the literal freed must
 * hold it. The canonicalizer rewrites a value while it is read — whitespace dropped, string
 * escapes resolved, a number's redundant digits removed — without changing the value it decodes
 * to, so an equivalent repeat never crowds out another slot (#209).
 *
 * The rewrite is incremental: the scanner reads a frame one byte at a time, and every byte of a
 * captured value is canonicalized as it arrives, so the retained bytes are the canonical ones.
 * Malformed input stays malformed: an invalid escape, a stray point and the whitespace between
 * two primitives are written as they stand.
 */
const QUOTE = 34
const BACKSLASH = 92
const SLASH = 47
const DOT = 46
const MINUS = 45
const PLUS = 43
const LOWER_E = 101
const UPPER_E = 69
const ZERO = 48
const NINE = 57
const SPACE = 32
const TAB = 9
const LINE_FEED = 10
const CARRIAGE_RETURN = 13

/** The bytes an escape keeps, as `JSON.stringify` writes them. */
const ESCAPE_BYTES: ReadonlyMap<number, readonly number[]> = new Map([
  [QUOTE, [BACKSLASH, QUOTE]],
  [BACKSLASH, [BACKSLASH, BACKSLASH]],
  [SLASH, [SLASH]],
  [98, [BACKSLASH, 98]],
  [102, [BACKSLASH, 102]],
  [110, [BACKSLASH, 110]],
  [114, [BACKSLASH, 114]],
  [116, [BACKSLASH, 116]],
])
/** The bytes a code point is written as when it needs an escape of its own. */
const CODE_POINT_BYTES: ReadonlyMap<number, readonly number[]> = new Map([
  [QUOTE, [BACKSLASH, QUOTE]],
  [BACKSLASH, [BACKSLASH, BACKSLASH]],
  [8, [BACKSLASH, 98]],
  [9, [BACKSLASH, 116]],
  [10, [BACKSLASH, 110]],
  [12, [BACKSLASH, 102]],
  [13, [BACKSLASH, 114]],
])

/** The value of a hex digit, or -1 when the byte is not one. */
function hexValue(byte: number): number {
  if (byte >= ZERO && byte <= NINE) return byte - ZERO
  if (byte >= 97 && byte <= 102) return byte - 87
  if (byte >= 65 && byte <= 70) return byte - 55
  return -1
}

/** The code point as the UTF-8 bytes `JSON.stringify` writes it. */
function utf8Bytes(code: number): number[] {
  if (code < 0x80) return [code]
  if (code < 0x800) return [0xc0 | (code >> 6), 0x80 | (code & 0x3f)]
  if (code < 0x10000)
    return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)]
  return [
    0xf0 | (code >> 18),
    0x80 | ((code >> 12) & 0x3f),
    0x80 | ((code >> 6) & 0x3f),
    0x80 | (code & 0x3f),
  ]
}

export interface SlotCanonicalizer {
  /** The canonical bytes the last `push` (or `end`) produced. */
  readonly written: readonly number[]
  /** Feed one source byte of the value. */
  push(byte: number): void
  /** Close the value: the bytes that only its end knows are written. */
  end(): void
}

export function createSlotCanonicalizer(): SlotCanonicalizer {
  let mode: "value" | "string" | "number" | "literal" = "value"
  // The escape being read: a backslash, then its target, then four hex digits.
  let escapeState: "none" | "simple" | "unicode" = "none"
  let hexDigits = 0
  let hexText = ""
  let codePoint = 0
  // The number being read: its fraction, the zeros dropped from the fraction's tail, and whether
  // the fraction's point has been written.
  let inFraction = false
  let inExponent = false
  let fractionDigits = 0
  let droppedZeros = 0
  let pointWritten = false
  // The whitespace after a primitive: it stays a separator while the next token may continue
  // it, so an invalid `1 2` never becomes a valid `12`.
  let spacePending = false
  let spaceAfterPrimitive = false
  let afterPrimitive = false
  const written: number[] = []

  /** The fraction's point and the zeros dropped after it, written when a digit survives them. */
  const writePoint = (): void => {
    if (!inFraction || pointWritten) return
    pointWritten = true
    written.push(DOT)
    for (let at = 0; at < droppedZeros; at++) written.push(ZERO)
    droppedZeros = 0
  }

  /** The number ends: a fraction of nothing but zeros loses its point with them. */
  const endNumber = (): void => {
    if (inFraction && !pointWritten) {
      pointWritten = true
      // `1.` is not a number: its point stays, so the frame stays malformed.
      if (fractionDigits === 0) written.push(DOT)
    }
    afterPrimitive = true
  }

  /** The code point of a `\uXXXX` escape, in the spelling `JSON.stringify` gives it. */
  const writeCodePoint = (code: number): void => {
    const escaped = CODE_POINT_BYTES.get(code)
    if (escaped !== undefined) {
      for (const part of escaped) written.push(part)
      return
    }
    // A control character, and a surrogate whose pair may still follow: both stay escaped.
    if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
      written.push(BACKSLASH, 117)
      for (const digit of code.toString(16).padStart(4, "0")) written.push(digit.charCodeAt(0))
      return
    }
    for (const part of utf8Bytes(code)) written.push(part)
  }

  /** A value: the byte starts one, or ends the number or literal before it. */
  const pushValue = (byte: number): void => {
    if (byte === SPACE || byte === TAB || byte === LINE_FEED || byte === CARRIAGE_RETURN) {
      spacePending = true
      spaceAfterPrimitive = afterPrimitive
      return
    }
    if (spacePending) {
      // The whitespace after a primitive stays a separator: `1 2`, `1 e 2` and `tr ue` are
      // malformed, and dropping the space would make them one token.
      if (spaceAfterPrimitive) written.push(SPACE)
      spacePending = false
      spaceAfterPrimitive = false
    }
    if (byte === QUOTE) {
      written.push(QUOTE)
      mode = "string"
      afterPrimitive = false
      return
    }
    if (byte === MINUS || (byte >= ZERO && byte <= NINE)) {
      written.push(byte)
      mode = "number"
      afterPrimitive = false
      return
    }
    if (byte === 116 || byte === 102 || byte === 110) {
      written.push(byte)
      mode = "literal"
      afterPrimitive = false
      return
    }
    // Structure, and anything the grammar does not allow: written as it stands.
    written.push(byte)
    afterPrimitive = false
  }

  const push = (byte: number): void => {
    written.length = 0
    switch (mode) {
      case "string": {
        if (escapeState === "simple") {
          escapeState = "none"
          if (byte === 117) {
            escapeState = "unicode"
            hexDigits = 0
            hexText = ""
            codePoint = 0
            return
          }
          const escaped = ESCAPE_BYTES.get(byte)
          if (escaped === undefined) {
            // An escape the grammar does not allow: written as it stands.
            written.push(BACKSLASH, byte)
            return
          }
          for (const part of escaped) written.push(part)
          return
        }
        if (escapeState === "unicode") {
          const digit = hexValue(byte)
          if (digit < 0) {
            // An invalid escape stays verbatim: the frame is malformed and must fail.
            written.push(BACKSLASH, 117)
            for (const part of hexText) written.push(part.charCodeAt(0))
            written.push(byte)
            escapeState = "none"
            return
          }
          codePoint = codePoint * 16 + digit
          hexText += String.fromCharCode(byte)
          hexDigits++
          if (hexDigits < 4) return
          escapeState = "none"
          writeCodePoint(codePoint)
          return
        }
        if (byte === QUOTE) {
          written.push(QUOTE)
          mode = "value"
          afterPrimitive = false
          return
        }
        if (byte === BACKSLASH) {
          escapeState = "simple"
          return
        }
        written.push(byte)
        return
      }
      case "number": {
        if (byte >= ZERO && byte <= NINE) {
          if (!inFraction) {
            written.push(byte)
            return
          }
          fractionDigits++
          // A zero at the fraction's tail says nothing until a digit that does follow it.
          if (byte === ZERO) {
            droppedZeros++
            return
          }
          writePoint()
          written.push(byte)
          return
        }
        if (byte === DOT && !inFraction && !inExponent) {
          inFraction = true
          fractionDigits = 0
          droppedZeros = 0
          return
        }
        if ((byte === LOWER_E || byte === UPPER_E) && !inExponent) {
          inExponent = true
          // The fraction is settled: its zeros come back, and its point with them.
          writePoint()
          written.push(byte)
          return
        }
        if ((byte === PLUS || byte === MINUS) && inExponent) {
          written.push(byte)
          return
        }
        endNumber()
        mode = "value"
        pushValue(byte)
        return
      }
      case "literal": {
        if ((byte >= 97 && byte <= 122) || (byte >= 65 && byte <= 90)) {
          written.push(byte)
          return
        }
        // The literal ends here: the whitespace that follows may still belong to it.
        afterPrimitive = true
        mode = "value"
        pushValue(byte)
        return
      }
      default:
        pushValue(byte)
    }
  }

  const end = (): void => {
    written.length = 0
    if (mode === "string") {
      // An unfinished escape stays verbatim: the value is malformed, and it must fail as it
      // stands rather than as a shorter string.
      if (escapeState === "simple") written.push(BACKSLASH)
      else if (escapeState === "unicode") {
        written.push(BACKSLASH, 117)
        for (const part of hexText) written.push(part.charCodeAt(0))
      }
      return
    }
    if (mode === "number") endNumber()
  }

  return { written, push, end }
}

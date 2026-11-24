import { type createPrimitive, endsPrimitive } from "./primitive"
import {
  type createStringValidation,
  ESCAPE_CLASS,
  NATIVE_RUN_BYTES,
  PLAIN,
  STRING_CLASS,
} from "./string-validation"

/**
 * Grammar validation of one nested value nothing is captured from.
 *
 * Admission still validates the whole body (a malformed tail must not reach an upstream), but below
 * the routing fields and the conversation opening no key is read and no frame object is needed:
 * only container kinds, a state per level and the string/number DFAs. Entering this for every
 * such subtree took structure-dense bodies (tool inputs, schemas, transcripts) from ~18 to a few
 * ns/B (plan 101, 02.1). Resumable across chunks; the scanner owns everything at depth 1 and in
 * the opening.
 */

// Per-level state, as bytes in one array.
const OBJECT_FIRST = 0 // `{` read: a key or `}`
const OBJECT_KEY = 1 // `,` read in an object: a key
const COLON = 2
const VALUE = 3 // `:` or an array's `,` read: a value
const AFTER_VALUE = 4 // `,` or the container's close
const ARRAY_FIRST = 5 // `[` read: a value or `]`

// What a byte outside a string is, so the token loop branches once instead of comparing seven times.
// 0 is everything else: the first byte of a number or literal.
const WHITESPACE = 1
const QUOTE = 2
const COMMA = 3
const COLON_MARK = 4
const OPEN = 5
const CLOSE = 6
const TOKEN = new Uint8Array(256)
for (const byte of [32, 9, 10, 13]) TOKEN[byte] = WHITESPACE
TOKEN[34] = QUOTE
TOKEN[44] = COMMA
TOKEN[58] = COLON_MARK
TOKEN[91] = TOKEN[123] = OPEN
TOKEN[93] = TOKEN[125] = CLOSE

export function createSkim(input: {
  readonly strings: ReturnType<typeof createStringValidation>
  readonly literal: ReturnType<typeof createPrimitive>
  readonly maximumJsonDepth: number
}) {
  const { strings, literal, maximumJsonDepth } = input
  const states = new Uint8Array(maximumJsonDepth + 1)
  const arrays = new Uint8Array(maximumJsonDepth + 1)
  // `depth` is local: 1 is the skimmed value itself, 0 means nothing is being skimmed.
  let depth = 0,
    base = 0,
    inString = false,
    key = false,
    primitive = false,
    dead = false
  return {
    invalid: false,
    depthExceeded: false,
    /** Inside a skimmed value; also true after a grammar error, which consumes the rest. */
    get active() {
      return depth > 0 || dead
    },
    /** The container opened by `byte` sits at absolute depth `outer + 1`. */
    begin(byte: number, outer: number) {
      base = outer
      depth = 1
      arrays[1] = byte === 91 ? 1 : 0
      states[1] = byte === 91 ? ARRAY_FIRST : OBJECT_FIRST
    },
    /** Consumes from `start`; returns the index just past the value's close, or `chunk.length`. */
    scan(chunk: Uint8Array, start: number): number {
      const n = chunk.length
      if (dead) return n
      // Hot loop state lives in locals and is written back once: closure slots cost a load and a
      // store per byte.
      let i = start,
        d = depth,
        str = inString,
        isKey = key,
        prim = primitive,
        failed = false
      while (i < n) {
        if (str) {
          if (!strings.pending) {
            // Inline: most strings end, and most escapes are two bytes, before a native search pays.
            const limit = Math.min(n, i + NATIVE_RUN_BYTES)
            for (;;) {
              while (i < limit && STRING_CLASS[chunk[i] ?? 0] === PLAIN) i++
              if (i + 1 >= n || i >= limit || chunk[i] !== 92) break
              if (ESCAPE_CLASS[chunk[i + 1] ?? 0] !== 1) break
              i += 2
            }
            if (i < n && chunk[i] !== 34) i = strings.skipString(chunk, i)
            if (i >= n) break
            if (chunk[i] === 34) {
              i++
              str = false
              states[d] = isKey ? COLON : AFTER_VALUE
              continue
            }
          }
          const b = chunk[i] ?? 0
          i++
          if (!strings.byte(b)) continue
          str = false
          states[d] = isKey ? COLON : AFTER_VALUE
          continue
        }
        const b = chunk[i] ?? 0
        if (prim) {
          if (!endsPrimitive(b)) {
            literal.byte(b)
            i++
            continue
          }
          prim = false
          if (!literal.finish()) {
            failed = true
            break
          }
          states[d] = AFTER_VALUE
        }
        i++
        const token = TOKEN[b]
        if (token === WHITESPACE) continue
        const state = states[d]
        const expectsValue = state === VALUE || state === ARRAY_FIRST
        if (token === QUOTE) {
          isKey = state === OBJECT_FIRST || state === OBJECT_KEY
          if (!isKey && !expectsValue) {
            failed = true
            break
          }
          str = true
          strings.reset()
        } else if (token === COMMA) {
          if (state !== AFTER_VALUE) {
            failed = true
            break
          }
          states[d] = arrays[d] === 1 ? VALUE : OBJECT_KEY
        } else if (token === COLON_MARK) {
          if (state !== COLON) {
            failed = true
            break
          }
          states[d] = VALUE
        } else if (token === OPEN) {
          if (!expectsValue) {
            failed = true
            break
          }
          if (base + d >= maximumJsonDepth) {
            this.depthExceeded = true
            failed = true
            break
          }
          d++
          arrays[d] = b === 91 ? 1 : 0
          states[d] = b === 91 ? ARRAY_FIRST : OBJECT_FIRST
        } else if (token === CLOSE) {
          const closes =
            (b === 93) === (arrays[d] === 1) &&
            (state === AFTER_VALUE || state === (b === 93 ? ARRAY_FIRST : OBJECT_FIRST))
          if (!closes) {
            failed = true
            break
          }
          d--
          if (d === 0) break
          states[d] = AFTER_VALUE
        } else {
          if (!expectsValue) {
            failed = true
            break
          }
          prim = true
          literal.start(b)
        }
      }
      depth = d
      inString = str
      key = isKey
      primitive = prim
      if (!failed) return Math.min(i, n)
      // A grammar error is final: the body is refused, so the rest only needs consuming.
      this.invalid = true
      dead = true
      return n
    },
  }
}

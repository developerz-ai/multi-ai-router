import { type createPrimitive, endsPrimitive, isWhitespace } from "./primitive"
import type { createStringValidation } from "./string-validation"

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
            i = strings.skipString(chunk, i)
            if (i >= n) break
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
        if (isWhitespace(b)) continue
        const state = states[d]
        const expectsValue = state === VALUE || state === ARRAY_FIRST
        if (b === 34) {
          isKey = state === OBJECT_FIRST || state === OBJECT_KEY
          if (!isKey && !expectsValue) {
            failed = true
            break
          }
          str = true
          strings.reset()
        } else if (b === 44) {
          if (state !== AFTER_VALUE) {
            failed = true
            break
          }
          states[d] = arrays[d] === 1 ? VALUE : OBJECT_KEY
        } else if (b === 58) {
          if (state !== COLON) {
            failed = true
            break
          }
          states[d] = VALUE
        } else if (b === 123 || b === 91) {
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
        } else if (b === 125 || b === 93) {
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
      if (!failed) return i >= n ? n : i
      // A grammar error is final: the body is refused, so the rest only needs consuming.
      this.invalid = true
      dead = true
      return n
    },
  }
}

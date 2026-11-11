import { createUtf8Validation } from "./utf8-validation"
/** No allocation proportional to unknown strings. Native byte searches retain fast skip. */
export function createStringValidation() {
  const utf8 = createUtf8Validation()
  return {
    escape: false,
    unicode: 0,
    failed: false,
    get invalid() {
      return this.failed || utf8.invalid
    },
    reset() {
      this.escape = false
      this.unicode = 0
    },
    get pending() {
      return this.escape || this.unicode > 0
    },
    byte(b: number) {
      if (b === 34 || b === 92) utf8.boundary()
      else utf8.byte(b)
      if (this.unicode) {
        if (!((b >= 48 && b <= 57) || (b >= 65 && b <= 70) || (b >= 97 && b <= 102)))
          this.failed = true
        this.unicode--
        return false
      }
      if (this.escape) {
        this.escape = false
        if (b === 117) this.unicode = 4
        else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(b)) this.failed = true
        return false
      }
      if (b === 92) {
        this.escape = true
        return false
      }
      if (b < 32) this.failed = true
      return b === 34
    },
    /**
     * Skips string content from `start` and returns the first byte the per-byte path must see:
     * the closing quote, an escape it must finish (split across chunks, or malformed), or the
     * chunk's end. Well-formed escapes are consumed here (plan 101, 02.1): code and transcripts
     * carry one every few bytes, and handing each to the per-byte path cost 8 ns/B. Long plain
     * runs go to native searches.
     */
    skipString(chunk: Uint8Array, start: number) {
      const n = chunk.length
      let i = start
      let run = start
      let nonAscii = utf8.pending
      while (i < n) {
        const byte = chunk[i] ?? 0
        if (byte === 34) break
        if (byte === 92) {
          if (nonAscii) utf8.segment(chunk, run, i)
          nonAscii = false
          utf8.boundary()
          const consumed = escapeLength(chunk, i)
          if (consumed === 0) return i
          i += consumed
          run = i
          continue
        }
        if (byte < 32) this.failed = true
        else if (byte >= 128) nonAscii = true
        i++
        // A long escape-free run (a pasted file, base64) goes to native searches instead.
        if (i - run === NATIVE_RUN_BYTES) {
          const quote = chunk.indexOf(34, i)
          const end = quote < 0 ? n : quote
          const slash = chunk.subarray(i, end).indexOf(92)
          const stop = slash < 0 ? end : i + slash
          // The loop above fed nothing to the UTF-8 validator: the whole run goes at once.
          this.segment(chunk, run, stop)
          i = stop
          run = stop
          nonAscii = false
        }
      }
      if (nonAscii) utf8.segment(chunk, run, i)
      return i
    },
    segment(chunk: Uint8Array, start: number, end: number) {
      if (end - start <= 64) {
        for (let i = start; i < end; i++) {
          const byte = chunk[i] ?? 0
          if (byte < 32) this.failed = true
          utf8.byte(byte)
        }
        return
      }
      utf8.segment(chunk, start, end)
      const segment = chunk.subarray(start, end)
      for (let control = 0; control < 32; control++) {
        const at = segment.indexOf(control)
        if (at >= 0) {
          this.failed = true
          break
        }
      }
    },
  }
}

/** Escape-free bytes after which a native search beats the byte loop's ~1.5 ns/B. */
const NATIVE_RUN_BYTES = 256

const SIMPLE_ESCAPES = new Set([34, 92, 47, 98, 102, 110, 114, 116])

function isHex(byte: number): boolean {
  return (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102)
}

/** Bytes a complete, valid escape at `at` spans; 0 leaves it to the per-byte path. */
function escapeLength(chunk: Uint8Array, at: number): number {
  const kind = chunk[at + 1]
  if (kind === undefined) return 0
  if (SIMPLE_ESCAPES.has(kind)) return 2
  if (kind !== 117 || at + 5 >= chunk.length) return 0
  for (let digit = at + 2; digit < at + 6; digit++) if (!isHex(chunk[digit] ?? 0)) return 0
  return 6
}

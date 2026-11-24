/**
 * Byte classes for the string hot loops. A table read is one load and one branch per byte, where the
 * comparisons it replaces were three.
 */
export const PLAIN = 0
/** What ends a plain run inside a string: the quote, an escape, or a raw control byte. */
export const STRING_CLASS = new Uint8Array(256)
for (let byte = 0; byte < 32; byte++) STRING_CLASS[byte] = 1
STRING_CLASS[34] = 1
STRING_CLASS[92] = 1

/** After a backslash: 1 is a complete two-byte escape, 2 is `\\u`, 0 is not an escape. */
export const ESCAPE_CLASS = new Uint8Array(256)
for (const byte of [34, 92, 47, 98, 102, 110, 114, 116]) ESCAPE_CLASS[byte] = 1
ESCAPE_CLASS[117] = 2

/** Escape-free bytes after which a native search beats the table loop. */
export const NATIVE_RUN_BYTES = 256

/**
 * The string grammar only. UTF-8 is validated natively per pushed chunk by the scanner, so nothing
 * here follows code points.
 */
export function createStringValidation() {
  return {
    escape: false,
    unicode: 0,
    invalid: false,
    reset() {
      this.escape = false
      this.unicode = 0
    },
    get pending() {
      return this.escape || this.unicode > 0
    },
    byte(b: number) {
      if (this.unicode) {
        if (!isHex(b)) this.invalid = true
        this.unicode--
        return false
      }
      if (this.escape) {
        this.escape = false
        const kind = ESCAPE_CLASS[b]
        if (kind === 2) this.unicode = 4
        else if (kind !== 1) this.invalid = true
        return false
      }
      if (b === 92) {
        this.escape = true
        return false
      }
      if (b < 32) this.invalid = true
      return b === 34
    },
    /**
     * Skips string content from `start` and returns the first byte the per-byte path must see:
     * the closing quote, an escape it must finish (split across chunks, or malformed), or the
     * chunk's end. Well-formed escapes are consumed here (plan 101, 02.1): code and transcripts
     * carry one every few bytes. Long plain runs go to native searches.
     */
    skipString(chunk: Uint8Array, start: number) {
      const n = chunk.length
      let i = start
      for (;;) {
        const limit = Math.min(n, i + NATIVE_RUN_BYTES)
        while (i < limit && STRING_CLASS[chunk[i] ?? 0] === PLAIN) i++
        if (i >= n) return n
        if (i === limit) {
          i = this.skipLongRun(chunk, i)
          continue
        }
        const byte = chunk[i] ?? 0
        if (byte === 34) return i
        if (byte !== 92) {
          this.invalid = true
          i++
          continue
        }
        const consumed = escapeLength(chunk, i)
        if (consumed === 0) return i
        i += consumed
      }
    },
    /** The next quote or backslash at or after `start`, found natively; controls between are refused. */
    skipLongRun(chunk: Uint8Array, start: number): number {
      const quote = chunk.indexOf(34, start)
      const end = quote < 0 ? chunk.length : quote
      const slash = chunk.subarray(start, end).indexOf(92)
      const stop = slash < 0 ? end : start + slash
      if (stop - start <= 64) {
        for (let i = start; i < stop; i++) if ((chunk[i] ?? 0) < 32) this.invalid = true
        return stop
      }
      const run = chunk.subarray(start, stop)
      for (let control = 0; control < 32; control++) {
        if (run.indexOf(control) < 0) continue
        this.invalid = true
        break
      }
      return stop
    },
  }
}

function isHex(byte: number): boolean {
  return (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102)
}

/** Bytes a complete, valid escape at `at` spans; 0 leaves it to the per-byte path. */
function escapeLength(chunk: Uint8Array, at: number): number {
  const next = chunk[at + 1]
  if (next === undefined) return 0
  const kind = ESCAPE_CLASS[next]
  if (kind === 1) return 2
  if (kind !== 2 || at + 5 >= chunk.length) return 0
  for (let digit = at + 2; digit < at + 6; digit++) if (!isHex(chunk[digit] ?? 0)) return 0
  return 6
}

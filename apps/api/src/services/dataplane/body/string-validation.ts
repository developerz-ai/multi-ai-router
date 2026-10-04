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
    skipString(chunk: Uint8Array, start: number) {
      const shortEnd = Math.min(chunk.length, start + 64)
      let nonAscii = utf8.pending
      for (let i = start; i < shortEnd; i++) {
        const byte = chunk[i] ?? 0
        if (byte === 34 || byte === 92) return i
        if (byte < 32) this.failed = true
        if (byte >= 128 || nonAscii) {
          utf8.byte(byte)
          nonAscii = utf8.pending
        }
      }
      if (shortEnd === chunk.length) return shortEnd
      const quote = chunk.indexOf(34, shortEnd)
      return this.skip(chunk, shortEnd, quote < 0 ? chunk.length : quote)
    },
    skip(chunk: Uint8Array, start: number, end: number) {
      if (end - start <= 64) {
        let nonAscii = utf8.pending
        for (let i = start; i < end; i++) {
          const byte = chunk[i] ?? 0
          if (byte === 92) return i
          if (byte < 32) this.failed = true
          if (byte >= 128 || nonAscii) {
            utf8.byte(byte)
            nonAscii = utf8.pending
          }
        }
        return end
      }
      const slash = chunk.subarray(start, end).indexOf(92),
        stop = slash < 0 ? end : start + slash
      this.segment(chunk, start, stop)
      return stop
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

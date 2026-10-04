import { isUtf8 } from "node:buffer"
/** Native validation of the complete middle; only a split codepoint retains ≤4 bytes. */
export function createUtf8Validation() {
  let tail: number[] = [],
    expected = 0
  return {
    invalid: false,
    get pending() {
      return expected > 0
    },
    byte(b: number) {
      if (expected) {
        if (b < 128 || b > 191) {
          this.invalid = true
          tail = []
          expected = 0
          return
        }
        tail.push(b)
        if (tail.length === expected) {
          if (!isUtf8(Uint8Array.from(tail))) this.invalid = true
          tail = []
          expected = 0
        }
        return
      }
      if (b < 128) return
      expected = b >= 194 && b <= 223 ? 2 : b >= 224 && b <= 239 ? 3 : b >= 240 && b <= 244 ? 4 : 0
      if (!expected) {
        this.invalid = true
        return
      }
      tail = [b]
    },
    segment(chunk: Uint8Array, start: number, end: number) {
      while (expected && start < end) this.byte(chunk[start++] ?? 0)
      if (start === end) return
      let last = end - 1
      while (
        last >= start &&
        last >= end - 4 &&
        (chunk[last] ?? 0) >= 128 &&
        (chunk[last] ?? 0) <= 191
      )
        last--
      const lead = chunk[last],
        length =
          lead === undefined
            ? 0
            : lead >= 194 && lead <= 223
              ? 2
              : lead >= 224 && lead <= 239
                ? 3
                : lead >= 240 && lead <= 244
                  ? 4
                  : 0
      const split = length && end - last < length ? last : end
      if (!isUtf8(chunk.subarray(start, split))) this.invalid = true
      for (let i = split; i < end; i++) this.byte(chunk[i] ?? 0)
    },
    boundary() {
      if (expected) {
        this.invalid = true
        tail = []
        expected = 0
      }
    },
  }
}

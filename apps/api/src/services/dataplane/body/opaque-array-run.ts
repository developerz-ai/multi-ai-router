import type { createStringValidation } from "./string-validation"
/** Ordinary array strings only. Caller already checked parent state and capture exclusion. */
export function createOpaqueArrayRun(strings: ReturnType<typeof createStringValidation>) {
  return {
    open: false,
    scan(chunk: Uint8Array, quote: number): number {
      let at = quote + 1
      strings.reset()
      this.open = true
      for (;;) {
        while (at < chunk.length) {
          const stop = strings.pending ? at : strings.skipString(chunk, at)
          if (stop === chunk.length) return stop
          const closed = strings.byte(chunk[stop] ?? 0)
          at = stop + 1
          if (closed) {
            this.open = false
            break
          }
        }
        if (this.open) return chunk.length
        const afterValue = at
        while (at < chunk.length && [32, 10, 13, 9].includes(chunk[at] ?? 0)) at++
        if (chunk[at] !== 44) return afterValue
        at++
        while (at < chunk.length && [32, 10, 13, 9].includes(chunk[at] ?? 0)) at++
        if (chunk[at] !== 34) return afterValue
        at++
        strings.reset()
        this.open = true
      }
    },
  }
}

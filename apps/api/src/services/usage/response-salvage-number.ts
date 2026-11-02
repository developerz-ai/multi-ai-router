/** Bounded numeric rewriting: trailing fraction zeros and zero exponents cost no room. */
export function createNumberCanonicalizer(emit: (byte: number) => boolean) {
  let active = true
  let fraction = false
  let fractionDigits = 0
  let zeros = 0
  let pointWritten = false
  let exponent = false
  let deferredExponent = false
  let exponentMarker = 101
  let exponentSign = 0
  let exponentZeros = 0
  const write = (byte: number): void => {
    if (active) active = emit(byte)
  }
  const writePoint = (): void => {
    if (!fraction) return
    if (!pointWritten) write(46)
    pointWritten = true
    for (; active && zeros > 0; zeros--) write(48)
    zeros = 0
  }
  const endFraction = (): void => {
    // A bare point must survive even when a following exponent would otherwise be valid.
    if (fraction && !pointWritten && fractionDigits === 0) write(46)
    pointWritten = true
  }
  const flushExponent = (): void => {
    if (!deferredExponent) return
    write(exponentMarker)
    if (exponentSign !== 0) write(exponentSign)
    for (; active && exponentZeros > 0; exponentZeros--) write(48)
    deferredExponent = false
  }
  return {
    /** The first byte is emitted by the caller; reset for each numeric token. */
    start() {
      fraction = pointWritten = exponent = deferredExponent = false
      fractionDigits = zeros = exponentSign = exponentZeros = 0
    },
    /** False means this byte belongs to the enclosing value, not this number. */
    push(byte: number): boolean {
      if (byte >= 48 && byte <= 57) {
        if (exponent) {
          if (deferredExponent && byte === 48) exponentZeros++
          else {
            flushExponent()
            write(byte)
          }
        } else if (fraction) {
          fractionDigits++
          if (byte === 48) zeros++
          else {
            writePoint()
            write(byte)
          }
        } else write(byte)
        return true
      }
      if (byte === 46 && !fraction && !exponent) {
        fraction = true
        return true
      }
      if ((byte === 101 || byte === 69) && !exponent) {
        endFraction()
        exponent = deferredExponent = true
        exponentMarker = byte
        return true
      }
      if ((byte === 43 || byte === 45) && exponent) {
        if (deferredExponent && exponentSign === 0 && exponentZeros === 0) exponentSign = byte
        else {
          flushExponent()
          write(byte)
        }
        return true
      }
      // Never erase the grammar separating two numeric fragments (e.g. 1008.0.0 or 1e0.0).
      if (byte === 46 || byte === 101 || byte === 69) {
        if (!exponent) writePoint()
        flushExponent()
      }
      return false
    },
    end() {
      endFraction()
      // Only a complete, all-zero exponent disappears; incomplete exponents stay malformed.
      if (deferredExponent && exponentZeros === 0) flushExponent()
      deferredExponent = false
    },
  }
}

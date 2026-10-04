import { expect, test } from "bun:test"
import { createStringValidation } from "../../../src/services/dataplane/body/string-validation"

test("segment searches stay inside byte interval and ignore outside control", () => {
  const chunk = new TextEncoder().encode("x".repeat(2048) + "\u0000" + "z".repeat(4096))
  const native = Uint8Array.prototype.indexOf
  let searches = 0,
    maxBytes = 0
  Uint8Array.prototype.indexOf = function (search: number, from?: number) {
    searches++
    maxBytes = Math.max(maxBytes, this.length - (from ?? 0))
    return native.call(this, search, from)
  }
  try {
    const validation = createStringValidation()
    for (let i = 0; i < 100; i++) validation.segment(chunk, 100, 102)
    expect(validation.invalid).toBe(false)
    expect(maxBytes).toBeLessThanOrEqual(2)
    expect(searches).toBe(0)
  } finally {
    Uint8Array.prototype.indexOf = native
  }
})

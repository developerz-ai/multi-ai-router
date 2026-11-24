import { expect, test } from "bun:test"
import { createRoutingScanner } from "../../../src/services/dataplane/body/scanner"
import { createStringValidation } from "../../../src/services/dataplane/body/string-validation"

test("a long run stops at the next quote or escape and refuses only its own control bytes", () => {
  const chunk = new TextEncoder().encode(`${"x".repeat(2048)}\u0000${"z".repeat(4096)}"\u0001`)
  const whole = createStringValidation()
  expect(whole.skipLongRun(chunk, 0)).toBe(chunk.length - 2)
  expect(whole.invalid).toBe(true)
  const after = createStringValidation()
  expect(after.skipLongRun(chunk, 2049)).toBe(chunk.length - 2)
  expect(after.invalid).toBe(false)
})

test("a short run before the closing quote is checked byte by byte", () => {
  const bytes = new TextEncoder().encode('ab\u0002cd"')
  const validation = createStringValidation()
  expect(validation.skipString(bytes, 0)).toBe(bytes.length - 1)
  expect(validation.invalid).toBe(true)
})

/** Where a multi-byte character falls must never matter: UTF-8 is checked per chunk, natively. */
test("malformed UTF-8 is refused anywhere, and a split codepoint is not malformed", () => {
  const good = new TextEncoder().encode(
    '{"model":"m","messages":[{"role":"user","content":"é→😀"}]}',
  )
  for (let cut = 1; cut < good.length; cut++) {
    const scanner = createRoutingScanner()
    scanner.push(good.subarray(0, cut))
    scanner.push(good.subarray(cut))
    expect(scanner.finish().invalid).toBe(false)
  }
  const bad = good.slice()
  bad[bad.indexOf(0xc3)] = 0xff
  const scanner = createRoutingScanner()
  scanner.push(bad)
  expect(scanner.finish().invalid).toBe(true)
})

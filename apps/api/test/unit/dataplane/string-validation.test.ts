import { expect, test } from "bun:test"
import { createStringValidation } from "../../../src/services/dataplane/body/string-validation"

test("small segments ignore control bytes and malformed UTF8 outside their interval", () => {
  const chunk = new TextEncoder().encode("x".repeat(2048) + "\u0000" + "z".repeat(4096))
  chunk[4096] = 255
  const validation = createStringValidation()
  for (let i = 0; i < 100; i++) validation.segment(chunk, 100, 102)
  expect(validation.invalid).toBe(false)
  const control = createStringValidation()
  control.segment(chunk, 2047, 2049)
  expect(control.invalid).toBe(true)
  const malformed = createStringValidation()
  malformed.segment(chunk, 4095, 4097)
  expect(malformed.invalid).toBe(true)
})

test("large segments validate their own controls without inspecting the adjacent suffix", () => {
  const chunk = new TextEncoder().encode("x".repeat(2048) + "\u0000" + "z".repeat(4096))
  const outside = createStringValidation()
  outside.segment(chunk, 0, 2048)
  expect(outside.invalid).toBe(false)
  const inside = createStringValidation()
  inside.segment(chunk, 0, 2049)
  expect(inside.invalid).toBe(true)
})

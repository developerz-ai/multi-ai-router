import { expect, test } from "bun:test"
import { parseEnv } from "../../../src/config/env"

const env = {
  DATABASE_URL: "postgres://localhost/fixture",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
}
test("translation pending cap default and both inclusive configured bounds", () => {
  expect(parseEnv(env).translation.maximumPendingBytes).toBe(1_048_576)
  for (const value of [1024, 33_554_432])
    expect(
      parseEnv({ ...env, MAX_TRANSLATION_PENDING_BYTES: String(value) }).translation
        .maximumPendingBytes,
    ).toBe(value)
})
test("translation pending cap refuses nonfinite/fractional/out-of-range config", () => {
  for (const value of ["NaN", "Infinity", "1023", "1024.5", "33554433"])
    expect(() => parseEnv({ ...env, MAX_TRANSLATION_PENDING_BYTES: value })).toThrow()
})

test("out-of-range translation pending cap names its inclusive bounds", () => {
  for (const value of ["1023", "33554433"])
    expect(() => parseEnv({ ...env, MAX_TRANSLATION_PENDING_BYTES: value })).toThrow(
      "must be between 1024 and 33554432",
    )
})

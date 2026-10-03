import { expect, test } from "bun:test"
import { EnvValidationError, parseEnv } from "../../src/config/env"

const base = {
  DATABASE_URL: "postgres://router:router@localhost/router",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
}
test("active request bound has a finite production default and configurable positive range", () => {
  expect(parseEnv(base).relayLifetimes.maximumEntries).toBe(65536)
  expect(parseEnv({ ...base, ACTIVE_REQUEST_MAX_ENTRIES: "1" }).relayLifetimes.maximumEntries).toBe(
    1,
  )
  expect(
    parseEnv({ ...base, ACTIVE_REQUEST_MAX_ENTRIES: "1048576" }).relayLifetimes.maximumEntries,
  ).toBe(1048576)
  for (const value of ["0", "-1", "1.5", "Infinity", "1048577"])
    expect(() => parseEnv({ ...base, ACTIVE_REQUEST_MAX_ENTRIES: value })).toThrow(
      EnvValidationError,
    )
})

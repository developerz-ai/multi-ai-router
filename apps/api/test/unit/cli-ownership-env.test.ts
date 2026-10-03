import { expect, test } from "bun:test"
import { CLI_OWNERSHIP_ENV_FIELDS } from "../../src/config/cli-ownership"
import { parseEnv } from "../../src/config/env"

const base = {
  DATABASE_URL: "postgres://router:router@localhost/router",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
}

test("ownership defaults fit the native parser and local helper artifact", () => {
  expect(parseEnv(base).cliOwnership).toEqual({
    helperPath: "native/config-owner",
    maximumOwners: 64,
    termGraceMs: 1000,
    pollMs: 25,
    maximumChildren: 256,
    admissionTimeoutMs: 10_000,
    cleanupMaximumEntries: 100_000,
    cleanupMaximumDepth: 64,
    operationTimeoutMs: 15_000,
  })
})

test("native ownership counts and deadlines reject zero, overflow and fractional input", () => {
  for (const name of Object.keys(CLI_OWNERSHIP_ENV_FIELDS)) {
    if (name === "CLAUDE_OWNERSHIP_HELPER_PATH") continue
    for (const value of ["0", "-1", "1.5", "2147483648"])
      expect(() => parseEnv({ ...base, [name]: value })).toThrow(name)
  }
  expect(() => parseEnv({ ...base, CLAUDE_OWNERSHIP_CLEANUP_MAX_DEPTH: "257" })).toThrow(
    "CLAUDE_OWNERSHIP_CLEANUP_MAX_DEPTH",
  )
})

test("container helper override stays explicit", () => {
  expect(
    parseEnv({ ...base, CLAUDE_OWNERSHIP_HELPER_PATH: "/usr/local/libexec/router-cli-owner" })
      .cliOwnership.helperPath,
  ).toBe("/usr/local/libexec/router-cli-owner")
})

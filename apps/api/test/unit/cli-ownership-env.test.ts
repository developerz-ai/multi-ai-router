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
    replicaLease: {
      ttlMs: 30_000,
      heartbeatMs: 5000,
      safetyMarginMs: 2000,
      batchSize: 64,
      storageAttachment: "local",
      storageIdentity: null,
      attachmentHelperPath: null,
    },
  })
})

test("native ownership counts and deadlines reject zero, overflow and fractional input", () => {
  for (const name of Object.keys(CLI_OWNERSHIP_ENV_FIELDS)) {
    if (!/(?:_MS|_SIZE|_DEPTH|_ENTRIES|_CHILDREN|_ACCOUNT)$/.test(name)) continue
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

test("replica lease bounds and safety margin reject unsafe deadlines", () => {
  for (const ttl of ["99", "300001"])
    expect(() => parseEnv({ ...base, CLAUDE_OWNERSHIP_LEASE_TTL_MS: ttl })).toThrow(
      "CLAUDE_OWNERSHIP_LEASE_TTL_MS",
    )
  for (const ttl of ["16999", "17000"])
    expect(() => parseEnv({ ...base, CLAUDE_OWNERSHIP_LEASE_TTL_MS: ttl })).toThrow(
      "TTL must exceed three heartbeats plus the safety margin",
    )
  expect(
    parseEnv({ ...base, CLAUDE_OWNERSHIP_LEASE_TTL_MS: "17001" }).cliOwnership.replicaLease.ttlMs,
  ).toBe(17001)
  expect(
    parseEnv({ ...base, CLAUDE_OWNERSHIP_LEASE_TTL_MS: "300000" }).cliOwnership.replicaLease.ttlMs,
  ).toBe(300000)
})

test("exclusive attachment requires identity and helper and rejects shared RWX", () => {
  expect(() =>
    parseEnv({ ...base, CLAUDE_OWNERSHIP_STORAGE_IDENTITY: "configured-local" }),
  ).toThrow("local identity is persistent and generated")
  const exclusive = { ...base, CLAUDE_OWNERSHIP_STORAGE_ATTACHMENT: "exclusive-reattach" }
  for (const partial of [
    {},
    { CLAUDE_OWNERSHIP_STORAGE_IDENTITY: "volume-a" },
    { CLAUDE_OWNERSHIP_ATTACHMENT_HELPER_PATH: "/opt/router/attach" },
  ])
    expect(() => parseEnv({ ...exclusive, ...partial })).toThrow("requires both")
  expect(
    parseEnv({
      ...exclusive,
      CLAUDE_OWNERSHIP_STORAGE_IDENTITY: "volume-a",
      CLAUDE_OWNERSHIP_ATTACHMENT_HELPER_PATH: "/opt/router/attach",
    }).cliOwnership.replicaLease.storageAttachment,
  ).toBe("exclusive-reattach")
  expect(() =>
    parseEnv({ ...base, CLAUDE_OWNERSHIP_ATTACHMENT_HELPER_PATH: "/opt/router/attach" }),
  ).toThrow("requires CLAUDE_OWNERSHIP_STORAGE_ATTACHMENT=exclusive-reattach")
  expect(() => parseEnv({ ...base, CLAUDE_OWNERSHIP_STORAGE_ATTACHMENT: "rwx" })).toThrow(
    "CLAUDE_OWNERSHIP_STORAGE_ATTACHMENT",
  )
})

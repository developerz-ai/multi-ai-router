import { describe, expect, test } from "bun:test"
import { getTableColumns, getTableName, type Table } from "drizzle-orm"
import * as schema from "../../src/schema/index"

/**
 * Static shape assertions — no database required. These lock the columns the
 * access patterns in `docs/idea/02-domain-model.md` depend on, so a rename or a
 * dropped column fails here instead of at boot.
 */
const TABLE_COLUMNS: ReadonlyArray<{ table: Table; columns: readonly string[] }> = [
  {
    table: schema.accounts,
    columns: [
      "id",
      "label",
      "provider",
      "status",
      "authMaterial",
      "configDir",
      "tokenExpiresAt",
      "modelAliases",
      "weight",
      "priority",
      "createdAt",
      "updatedAt",
    ],
  },
  {
    table: schema.quotaWindows,
    columns: [
      "id",
      "accountId",
      "window",
      "utilization",
      "utilizationSource",
      "resetsAt",
      "resetSource",
      "lastCheckedAt",
      "createdAt",
    ],
  },
  { table: schema.pools, columns: ["id", "name", "policy", "createdAt", "updatedAt"] },
  {
    table: schema.poolMembers,
    columns: ["id", "poolId", "accountId", "weight", "priority", "createdAt"],
  },
  {
    table: schema.apiKeys,
    columns: [
      "id",
      "name",
      "value",
      "prefix",
      "scope",
      "rateLimitRequests",
      "rateLimitWindowSeconds",
      "expiresAt",
      "revoked",
      "revokedAt",
      "lastUsedAt",
      "createdAt",
      "updatedAt",
    ],
  },
  { table: schema.apiKeyPools, columns: ["id", "apiKeyId", "poolId", "createdAt"] },
  { table: schema.apiKeyAccounts, columns: ["id", "apiKeyId", "accountId", "createdAt"] },
  {
    table: schema.sessions,
    columns: [
      "id",
      "key",
      "apiKeyId",
      "accountId",
      "sdkSessionId",
      "lineageState",
      "fingerprintSource",
      "lastUsedAt",
      "createdAt",
    ],
  },
  {
    table: schema.usageRecords,
    columns: [
      "id",
      "correlationId",
      "attempt",
      "apiKeyId",
      "accountId",
      "provider",
      "sessionKey",
      "model",
      "tokensIn",
      "tokensOut",
      "cacheReadTokens",
      "cacheWriteTokens",
      "costEstimate",
      "costBasis",
      "latencyMs",
      "routerOverheadMs",
      "outcome",
      "createdAt",
    ],
  },
  {
    table: schema.usageDaily,
    columns: [
      "id",
      "day",
      "apiKeyId",
      "accountId",
      "model",
      "requests",
      "attempts",
      "errors",
      "tokensIn",
      "tokensOut",
      "cacheReadTokens",
      "cacheWriteTokens",
      "costMetered",
      "costNotional",
      "updatedAt",
    ],
  },
  {
    table: schema.auditEvents,
    columns: ["id", "kind", "subjectType", "subjectId", "detail", "createdAt"],
  },
  {
    table: schema.scheduledTaskRuns,
    columns: ["id", "task", "startedAt", "finishedAt", "outcome", "itemsProcessed", "error"],
  },
  {
    table: schema.oauthStates,
    columns: [
      "id",
      "state",
      "codeVerifier",
      "provider",
      "accountId",
      "redirectUri",
      "consumedAt",
      "expiresAt",
      "createdAt",
    ],
  },
]

describe("table columns", () => {
  for (const { table, columns } of TABLE_COLUMNS) {
    test(`${getTableName(table)} exposes exactly its documented columns`, () => {
      const actual = Object.keys(getTableColumns(table)).sort()
      expect(actual).toEqual([...columns].sort())
    })
  }

  test("every table has a uuid primary key with a database-side default", () => {
    for (const { table } of TABLE_COLUMNS) {
      const columns = getTableColumns(table)
      const id = columns.id
      expect(id).toBeDefined()
      expect(id?.primary).toBe(true)
      expect(id?.hasDefault).toBe(true)
      expect(id?.getSQLType()).toBe("uuid")
    }
  })

  test("every timestamp carries a time zone", () => {
    for (const { table } of TABLE_COLUMNS) {
      for (const column of Object.values(getTableColumns(table))) {
        const sqlType = column.getSQLType()
        if (sqlType.startsWith("timestamp")) {
          expect(sqlType).toBe("timestamp with time zone")
        }
      }
    }
  })
})

describe("session binding is persisted truth on the SDK path", () => {
  test("sessions carry both the account binding and the SDK session id", () => {
    expect(schema.sessions.accountId).toBeDefined()
    expect(schema.sessions.sdkSessionId).toBeDefined()
  })

  test("the binding is optional — the plain HTTP path recomputes placement", () => {
    expect(schema.sessions.accountId.notNull).toBe(false)
    expect(schema.sessions.sdkSessionId.notNull).toBe(false)
  })

  test("a session always belongs to the key that owns it", () => {
    expect(schema.sessions.apiKeyId.notNull).toBe(true)
    expect(schema.sessions.key.notNull).toBe(true)
  })
})

describe("usage records are one row per upstream attempt", () => {
  test("attempts of one client request are joinable by correlation id", () => {
    expect(schema.usageRecords.correlationId.notNull).toBe(true)
    expect(schema.usageRecords.correlationId.getSQLType()).toBe("uuid")
    expect(schema.usageRecords.attempt.notNull).toBe(true)
  })

  test("cache tokens are broken out and router overhead is recorded", () => {
    expect(schema.usageRecords.cacheReadTokens.notNull).toBe(true)
    expect(schema.usageRecords.cacheWriteTokens.notNull).toBe(true)
    expect(schema.usageRecords.routerOverheadMs.notNull).toBe(true)
    expect(schema.usageRecords.outcome.notNull).toBe(true)
  })

  test("cost is nullable — an unknown model is never silently zero", () => {
    expect(schema.usageRecords.costEstimate.notNull).toBe(false)
  })
})

describe("quota window state carries its own trustworthiness", () => {
  test("utilization is nullable, because a threshold-triggered source reports nothing", () => {
    expect(schema.quotaWindows.utilization.notNull).toBe(false)
  })

  test("both sources are always present, so a gauge is never read bare", () => {
    expect(schema.quotaWindows.utilizationSource.notNull).toBe(true)
    expect(schema.quotaWindows.resetSource.notNull).toBe(true)
  })

  test("resetsAt is nullable — an exhausted account has no reset by definition", () => {
    expect(schema.quotaWindows.resetsAt.notNull).toBe(false)
  })

  test("lastCheckedAt is required, because a reading without one is unreadable", () => {
    expect(schema.quotaWindows.lastCheckedAt.notNull).toBe(true)
  })
})

describe("accounts", () => {
  test("Claude subscription accounts hold a config dir instead of auth material", () => {
    expect(schema.accounts.configDir.notNull).toBe(false)
    expect(schema.accounts.authMaterial.notNull).toBe(false)
  })

  test("weight and priority exist for the weighted and failover policies", () => {
    expect(schema.accounts.weight.notNull).toBe(true)
    expect(schema.accounts.priority.notNull).toBe(true)
  })

  test("the model alias map is jsonb and optional", () => {
    expect(schema.accounts.modelAliases.getSQLType()).toBe("jsonb")
    expect(schema.accounts.modelAliases.notNull).toBe(false)
  })
})

describe("api keys are retrievable, not hashed", () => {
  test("the encrypted value and its indexed display prefix are both stored", () => {
    expect(schema.apiKeys.value.notNull).toBe(true)
    expect(schema.apiKeys.prefix.notNull).toBe(true)
  })

  test("revocation is a flag, so historical usage stays joinable", () => {
    expect(schema.apiKeys.revoked.notNull).toBe(true)
    expect(schema.apiKeys.revoked.hasDefault).toBe(true)
  })
})

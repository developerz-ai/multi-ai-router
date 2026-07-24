import { describe, expect, test } from "bun:test"
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core"
import { apiKeys, sessions, usageDaily, usageRecords } from "../../src/schema/index"

/** Index columns are columns or raw SQL; only the former carry a name. */
function nameOf(target: object): string | undefined {
  const value = Reflect.get(target, "name")
  return typeof value === "string" ? value : undefined
}

interface IndexShape {
  readonly unique: boolean
  readonly columns: readonly (string | undefined)[]
}

function indexShape(table: PgTable, name: string): IndexShape {
  const found = getTableConfig(table).indexes.find((index) => index.config.name === name)
  if (found === undefined) {
    throw new Error(`index ${name} is missing`)
  }
  return {
    unique: found.config.unique,
    columns: found.config.columns.map((column) => nameOf(column)),
  }
}

describe("the indexes the access patterns actually need", () => {
  test("key verification is a display-prefix lookup, not a table scan", () => {
    const index = indexShape(apiKeys, "api_keys_prefix_idx")
    expect(index.columns).toEqual(["prefix"])
    // Not unique: a prefix collision is resolved by the constant-time compare.
    expect(index.unique).toBe(false)
  })

  test("usage is queried by key and by account over a time window", () => {
    expect(indexShape(usageRecords, "usage_records_api_key_created_idx").columns).toEqual([
      "api_key_id",
      "created_at",
    ])
    expect(indexShape(usageRecords, "usage_records_account_created_idx").columns).toEqual([
      "account_id",
      "created_at",
    ])
  })

  test("the attempts of one client request are retrievable together", () => {
    expect(indexShape(usageRecords, "usage_records_correlation_idx").columns).toEqual([
      "correlation_id",
    ])
  })

  test("the retention sweep can delete raw usage by age", () => {
    expect(indexShape(usageRecords, "usage_records_created_at_idx").columns).toEqual(["created_at"])
  })

  test("session lookup is unique per owning key", () => {
    const index = indexShape(sessions, "sessions_api_key_key_key")
    expect(index.columns).toEqual(["api_key_id", "key"])
    expect(index.unique).toBe(true)
  })

  test("the idle-session sweep has an index to work from", () => {
    expect(indexShape(sessions, "sessions_last_used_at_idx").columns).toEqual(["last_used_at"])
  })

  test("the daily rollup is idempotent per (day, key, account, model)", () => {
    const index = indexShape(usageDaily, "usage_daily_grain_key")
    expect(index.columns).toEqual(["day", "api_key_id", "account_id", "model"])
    expect(index.unique).toBe(true)
  })
})

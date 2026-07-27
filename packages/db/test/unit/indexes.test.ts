import { describe, expect, test } from "bun:test"
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core"
import { apiKeys, sessions, usageDaily, usageRecords } from "../../src/schema/index"

/** Index columns are columns or raw SQL; only the former carry a name. */
function nameOf(target: object): string | undefined {
  const value = Reflect.get(target, "name")
  return typeof value === "string" ? value : undefined
}

/**
 * An index entry may be a column or a SQL expression. Expressions have no `name`, so they are
 * rendered from their chunks — an expression index is still part of the grain and a test that
 * silently read it as `undefined` would assert nothing about it.
 */
function entryOf(target: object): string | undefined {
  const name = nameOf(target)
  if (name !== undefined) return name
  const queryChunks: unknown = Reflect.get(target, "queryChunks")
  if (!Array.isArray(queryChunks)) return undefined
  return queryChunks.map((chunk) => renderChunk(chunk)).join("")
}

/** A chunk is a literal fragment (`StringChunk`, whose `value` is a string array) or a column. */
function renderChunk(chunk: unknown): string {
  if (typeof chunk === "string") return chunk
  if (chunk === null || typeof chunk !== "object") return ""
  const literal: unknown = Reflect.get(chunk, "value")
  if (Array.isArray(literal)) return literal.join("")
  if (typeof literal === "string") return literal
  return nameOf(chunk) ?? ""
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
    columns: found.config.columns.map((column) => entryOf(column)),
  }
}

describe("the indexes the access patterns actually need", () => {
  test("key verification is a display-prefix lookup, not a table scan", () => {
    const index = indexShape(apiKeys, "api_keys_prefix_idx")
    expect(index.columns).toEqual(["prefix"])
    // Not unique: a prefix collision is resolved by the constant-time compare.
    expect(index.unique).toBe(false)
  })

  test("usage breakdowns filter by time window alone, never by key or account", () => {
    // usage-read-repository.ts filters every query on createdAt only; apiKeyId/accountId are
    // group-by dimensions applied after the window scan, never a leading predicate column. An
    // (api_key_id, created_at) or (account_id, created_at) index can't serve that access pattern
    // — it would just be three extra B-tree inserts per row on the write-heaviest table with
    // nothing ever reading it. If a per-key/per-account drilldown starts filtering on the id
    // itself, add the index back naming the query that needs it.
    expect(
      getTableConfig(usageRecords).indexes.some(
        (index) => index.config.name === "usage_records_api_key_created_idx",
      ),
    ).toBe(false)
    expect(
      getTableConfig(usageRecords).indexes.some(
        (index) => index.config.name === "usage_records_account_created_idx",
      ),
    ).toBe(false)
    expect(
      getTableConfig(usageRecords).indexes.some(
        (index) => index.config.name === "usage_records_session_key_idx",
      ),
    ).toBe(false)
  })

  test("the attempts of one client request are retrievable together", () => {
    expect(indexShape(usageRecords, "usage_records_correlation_idx").columns).toEqual([
      "correlation_id",
    ])
  })

  test("a support request names a client request id, and that is a lookup", () => {
    // Partial: NULL on every row whose id the router minted, which is nearly all of them, and this
    // is the write-heaviest table in the schema.
    const index = indexShape(usageRecords, "usage_records_client_request_idx")
    expect(index.columns).toEqual(["client_request_id"])
    expect(index.unique).toBe(false)
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

  test("the daily rollup is idempotent per (day, key, account, pool, model)", () => {
    const index = indexShape(usageDaily, "usage_daily_grain_key")
    expect(index.unique).toBe(true)
    expect(index.columns[0]).toBe("day")
    expect(index.columns[1]).toBe("api_key_id")
    expect(index.columns[2]).toBe("account_id")
    expect(index.columns[4]).toBe("model")
  })

  test("the rollup grain coalesces a null pool, or every unscoped total would double", () => {
    // Two NULLs are distinct in Postgres, so a bare nullable `pool_id` in a unique index would
    // let the hourly rollup insert a fresh "no pool" row on every run instead of upserting.
    const index = indexShape(usageDaily, "usage_daily_grain_key")
    expect(index.columns[3]).toContain("coalesce")
    expect(index.columns[3]).toContain("pool_id")
  })
})

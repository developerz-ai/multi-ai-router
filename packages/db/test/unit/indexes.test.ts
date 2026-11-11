import { describe, expect, test } from "bun:test"
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core"
import {
  accounts,
  apiKeys,
  modelCatalog,
  quotaWindows,
  scheduledTaskRuns,
  sessions,
  usageContributions,
  usageDaily,
  usageRecords,
} from "../../src/schema/index"

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

function namesOf(table: PgTable): string[] {
  return getTableConfig(table).indexes.map((index) => index.config.name ?? "")
}

describe("the indexes the access patterns actually need", () => {
  test("key verification is a display-prefix lookup, not a table scan", () => {
    const index = indexShape(apiKeys, "api_keys_prefix_idx")
    expect(index.columns).toEqual(["prefix"])
    // Not unique: a prefix collision is resolved by the constant-time compare.
    expect(index.unique).toBe(false)
  })

  test("per-account reads lead with the account; nothing reads by key or session first", () => {
    // `tokensSince` (window gauges on every accounts list) and the usage reads' account filter
    // are `account_id = $1 and created_at >= $2` predicates. 0015 dropped this index on the
    // belief that accountId was only a group-by dimension; 0044 restores it (with the token
    // columns INCLUDEd in SQL, so the gauge is index-only).
    expect(indexShape(usageRecords, "usage_records_account_created_idx").columns).toEqual([
      "account_id",
      "created_at",
    ])
    // Still no (api_key_id, created_at) or session-key index: no query leads with either, and
    // each would be one more btree insert per row on the write-heaviest table.
    for (const name of ["usage_records_api_key_created_idx", "usage_records_session_key_idx"])
      expect(namesOf(usageRecords)).not.toContain(name)
  })

  test("indexes nothing reads are gone (0044)", () => {
    // Each had no reader in src/repositories (the only place SQL lives), and two had a write cost:
    // `accounts_last_used_at_idx` made every usage flush's stamp a non-HOT update, and
    // `usage_contributions_source_idx` was a third btree insert on the hottest insert table.
    const dead: readonly [PgTable, string][] = [
      [accounts, "accounts_provider_idx"],
      [accounts, "accounts_status_idx"],
      [accounts, "accounts_last_used_at_idx"],
      [usageContributions, "usage_contributions_source_idx"],
      [quotaWindows, "quota_windows_resets_at_idx"],
      [modelCatalog, "model_catalog_model_id_idx"],
    ]
    for (const [table, name] of dead) expect(namesOf(table)).not.toContain(name)
  })

  test("the rare legacy receipts and the open task runs each have a partial index", () => {
    expect(indexShape(usageContributions, "usage_contributions_legacy_day_idx").columns).toEqual([
      "day",
    ])
    expect(indexShape(scheduledTaskRuns, "scheduled_task_runs_open_idx").columns).toEqual([
      "task",
      "started_at",
    ])
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

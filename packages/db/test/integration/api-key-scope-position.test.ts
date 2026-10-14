import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createDatabase, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"

/**
 * Migration 0034 gives `api_key_pools` the listed order it always promised and
 * never stored. What has to survive the crossing is examined here against a real
 * PostgreSQL 16+: the backfill recovers each key's *today* order from physical
 * row order, and the column's DEFAULT keeps the previous release image's INSERT
 * — the one that omits `position` — working after the migration (and therefore
 * through a rollback). Own database, dropped afterwards; a shared development
 * database must look untouched.
 */
// `DATABASE_URL` and nothing else: `bin/check` refuses to run without one and
// `bin/test` names this file when it skips, so the skip can no longer be silent.
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const databaseName = `key_scope_pos_${crypto.randomUUID().replaceAll("-", "")}`

/** id order is the reverse of the listed order — that inversion is the bug being fixed. */
const POOL_A = "00000000-0000-4000-8000-00000000000a"
const POOL_B = "00000000-0000-4000-8000-00000000000b"
const KEY_ID = "10000000-0000-4000-8000-000000000001"
const SECOND_KEY_ID = "10000000-0000-4000-8000-000000000002"
const THIRD_POOL_ID = "00000000-0000-4000-8000-00000000000c"

let handle: DatabaseHandle | undefined
let admin: DatabaseHandle | undefined

beforeAll(async () => {
  if (!runnable) return
  admin = createDatabase({ url, maxConnections: 1 })
  await admin.sql.unsafe(`create database "${databaseName}"`)
  const uri = new URL(url)
  uri.pathname = `/${databaseName}`
  await runMigrations({ url: uri.toString(), migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url: uri.toString(), maxConnections: 2 })
  // Creating a database and running every migration outlasts bun's 5 s hook default on a busy box.
}, 60_000)

afterAll(async () => {
  await handle?.close()
  await admin?.sql.unsafe(`drop database if exists "${databaseName}" with (force)`)
  await admin?.close()
}, 30_000)

async function backfillFile(): Promise<string> {
  return Bun.file(new URL("../../migrations/0034_pool_scope_position.sql", import.meta.url)).text()
}

describe.skipIf(!runnable)("api_key_pools position migration against a live database", () => {
  test("the backfill numbers existing rows in their physical order, and re-running changes nothing", async () => {
    if (handle === undefined) return
    const live = handle

    await live.sql.unsafe(
      `insert into api_keys (id, name, value, prefix)
       values ('${KEY_ID}', 'scope-order', 'envelope', 'mar_live_scopeorder0key')`,
    )
    // One multi-row insert, B then A: pool_id order (A < B) and created_at order
    // (A's is set earlier) both disagree with the insert order, so only ctid —
    // today's physical order and what a seqscan returns now — yields [B, A].
    // That is the whole reason the backfill reads it.
    await live.sql.unsafe(
      `insert into pools (id, name) values ('${POOL_A}', 'pos-a'), ('${POOL_B}', 'pos-b')`,
    )
    await live.sql.unsafe(
      `insert into api_key_pools (api_key_id, pool_id, created_at) values ('${KEY_ID}', '${POOL_B}', '2026-01-02T00:00:00Z'), ('${KEY_ID}', '${POOL_A}', '2026-01-01T00:00:00Z')`,
    )

    const before =
      await live.sql`select ctid::text from api_key_pools where api_key_id = ${KEY_ID}::uuid order by ctid`
    expect(before).toHaveLength(2)

    const file = await backfillFile()
    await live.sql.unsafe(file)

    const ordered = await live.sql`
      select pool_id::text, "position" from api_key_pools
      where api_key_id = ${KEY_ID}::uuid order by "position"
    `
    expect(ordered).toEqual([
      { pool_id: POOL_B, position: 0 },
      { pool_id: POOL_A, position: 1 },
    ])

    // Re-running immediately after itself is a no-op on this layout. (The migrator
    // runs once, in one transaction under an advisory lock; this is a guard, not a
    // claim that a later re-run preserves order at scale.)
    await live.sql.unsafe(file)
    const rerun = await live.sql`
      select pool_id::text, "position" from api_key_pools
      where api_key_id = ${KEY_ID}::uuid order by "position"
    `
    expect(rerun).toEqual(ordered)
  })

  test("an insert that omits position — the previous image's shape — succeeds against the migrated schema", async () => {
    if (handle === undefined) return
    const live = handle

    await live.sql.unsafe(
      `insert into api_keys (id, name, value, prefix)
       values ('${SECOND_KEY_ID}', 'scope-rollback', 'envelope', 'mar_live_scoperollb')`,
    )
    await live.sql.unsafe(`insert into pools (id, name) values ('${THIRD_POOL_ID}', 'pos-c')`)

    // Exactly the INSERT the pre-0034 router issues: no `position` named. The
    // DEFAULT absorbs it, so a rolled-back deployment keeps writing keys.
    await live.sql.unsafe(
      `insert into api_key_pools (api_key_id, pool_id) values ('${SECOND_KEY_ID}', '${THIRD_POOL_ID}')`,
    )

    const rows = await live.sql`
      select pool_id::text, "position" from api_key_pools
      where api_key_id = ${SECOND_KEY_ID}::uuid
    `
    expect(rows).toEqual([{ pool_id: THIRD_POOL_ID, position: 0 }])
  })
})

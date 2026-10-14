import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  createApiKeyRepository,
  createDatabase,
  type DatabaseHandle,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { Hono } from "hono"
import { createLogger } from "../../src/logging/logger"
import { errorHandler, notFoundHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import { dataPlaneRoutes } from "../../src/routes/v1"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import {
  createDispatcher,
  createHealthStore,
  createRouterKeyVerifier,
  repositoryScopeLoader,
} from "../../src/services/dataplane"
import type { PoolSnapshot } from "../../src/services/routing"
import type { AppEnv } from "../../src/types"
import { adminMutationDatabase } from "../support/admin-mutation-database"
import {
  account,
  catalog,
  clock,
  jsonResponse,
  mockUpstream,
  usageSink,
} from "../unit/dataplane/fixtures"
import { MESSAGE, post, settle } from "./harness"

/**
 * The listed order of a pool-scoped key's scope, end to end: written by the
 * admin plane, persisted, read back, and honored by selection. `04-api-keys-and-
 * access.md` promises "the union, in the listed order", but nothing stored that
 * order — the planner was free to hand back pool-id order, silently turning a
 * key's primary pool into its fallback.
 *
 * Red on the parent commit by construction, not by luck: pool ids are pinned so
 * id order is the *reverse* of the listed order, and both scans that would
 * accidentally return insert order (seqscan, bitmapscan) are disabled for the
 * reads — the planner must use the unique `(api_key_id, pool_id)` index, which
 * is exactly the physical plan that produced the bug. The migration's backfill
 * is covered in `packages/db/test/integration/api-key-scope-position.test.ts`;
 * this file owns the router's behavior.
 */
// Needs a real PostgreSQL 16+ (migrations plus the admin mutation machinery);
// mocked upstreams only, same rule as every integration suite.
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const databaseName = `key_scope_order_${crypto.randomUUID().replaceAll("-", "")}`

/** id order is the reverse of the listed order — that inversion is the bug being fixed. */
const POOL_A = "00000000-0000-4000-8000-00000000000a"
const POOL_B = "00000000-0000-4000-8000-00000000000b"
const ACCOUNT_IN_B = "acct-pool-b"
const ACCOUNT_IN_A = "acct-pool-a"

let admin: DatabaseHandle | undefined
let db: ReturnType<typeof adminMutationDatabase> | undefined

beforeAll(async () => {
  if (!runnable) return
  admin = createDatabase({ url, maxConnections: 1 })
  await admin.sql.unsafe(`create database "${databaseName}"`)
  const uri = new URL(url)
  uri.pathname = `/${databaseName}`
  await runMigrations({ url: uri.toString(), migrationsFolder: defaultMigrationsFolder() })
  // One connection: the session-level planner flags below then provably reach
  // the scope loader's read, which postgres.js would otherwise run on any pooled
  // connection it grabbed next.
  db = adminMutationDatabase(uri.toString(), 1)
}, 60_000)

afterAll(async () => {
  await db?.close()
  await admin?.sql.unsafe(`drop database if exists "${databaseName}" with (force)`)
  await admin?.close()
}, 30_000)

describe.skipIf(!runnable)("a pool-scoped key's listed order", () => {
  test("survives create, update, and a forced-index-scan read; and routing serves the first-listed pool", async () => {
    if (db === undefined) return
    const live = db.handle

    await live.sql`
      insert into pools (id, name) values
        (${POOL_A}::uuid, ${db.name("a")}),
        (${POOL_B}::uuid, ${db.name("b")})
    `

    // Created with scope [B, A] — B first, against id order.
    const created = await db.keyService.create({
      name: db.name("key"),
      scope: { kind: "pools", poolIds: [POOL_B, POOL_A] },
    })
    if (!created.ok) throw new Error(`create failed: ${created.failure.message}`)
    expect(created.value.scope).toMatchObject({ kind: "pools", poolIds: [POOL_B, POOL_A] })

    // Updated with the same scope re-submitted: the edit deletes and re-inserts
    // the scope rows, so this is the path that used to lose the order.
    const updated = await db.keyService.update(created.value.id, {
      scope: { kind: "pools", poolIds: [POOL_B, POOL_A] },
    })
    if (!updated.ok) throw new Error(`update failed: ${updated.failure.message}`)
    expect(updated.value.scope).toMatchObject({ kind: "pools", poolIds: [POOL_B, POOL_A] })

    // The read the bug lived in, under the plan that produced it: with both
    // seqscan and bitmapscan disabled, the only plan left is the unique-index
    // scan whose order is pool-id order. SET LOCAL, because postgres.js pools
    // connections — the flags must die with this transaction.
    const readBack = await live.db.transaction(async (tx) => {
      await tx.execute("set local enable_seqscan = off")
      await tx.execute("set local enable_bitmapscan = off")
      return createApiKeyRepository(tx).listPoolTargets(created.value.id)
    })
    expect(readBack.map((row) => row.poolId)).toEqual([POOL_B, POOL_A])

    // --- and selection honors it ------------------------------------------------
    // Same flags, session-level this time so the loader's pooled read inherits
    // them: on the parent commit its index scan hands routing [A, B] and the
    // key's primary pool becomes its fallback.
    await live.sql.unsafe("set enable_seqscan = off")
    await live.sql.unsafe("set enable_bitmapscan = off")

    const cryptor = createCredentialCipher({ key: new Uint8Array(32).fill(3) })
    const accounts = [
      account(ACCOUNT_IN_B, {
        apiKey: `sk-${ACCOUNT_IN_B}`,
        cipher: cryptor,
        // Both pools serve the model natively, so native-first cannot reorder
        // across them and the listed order alone decides (05-routing-and-failover).
        snapshot: { supportedModels: ["claude-opus-5"] },
      }),
      account(ACCOUNT_IN_A, {
        apiKey: `sk-${ACCOUNT_IN_A}`,
        cipher: cryptor,
        snapshot: { supportedModels: ["claude-opus-5"] },
      }),
    ]
    const pools: PoolSnapshot[] = [
      {
        id: POOL_B,
        name: "scope-order-b",
        policy: "sticky",
        members: [{ accountId: ACCOUNT_IN_B }],
      },
      {
        id: POOL_A,
        name: "scope-order-a",
        policy: "sticky",
        members: [{ accountId: ACCOUNT_IN_A }],
      },
    ]

    const upstream = mockUpstream([() => jsonResponse(200, { ok: true })])
    const usage = usageSink()
    const health = createHealthStore({ jitter: () => 0 })
    const testClock = clock()
    const store = catalog(accounts, pools)
    const verifier = createRouterKeyVerifier({
      repository: db.keys,
      cipher: cryptor,
      // The production wiring, not the harness's options-built scope: the real
      // repository behind repositoryScopeLoader, so persisted order is what
      // selection sees.
      loadScope: repositoryScopeLoader(db.keys),
      now: testClock.now,
    })
    const logger = createLogger({ level: "error", write: () => undefined })
    const app = new Hono<AppEnv>()
    app.use("*", requestId())
    app.use("*", requestLogger(logger))
    app.onError(errorHandler(logger))
    app.notFound(notFoundHandler())
    app.route(
      "/",
      dataPlaneRoutes({
        verifier,
        catalog: store,
        health,
        now: testClock.now,
        dispatcher: createDispatcher({
          catalog: store,
          health,
          cipher: cryptor,
          usage,
          fetch: upstream.fetch,
          clock: testClock,
          options: { failover: { maxAttempts: 3 } },
        }),
      }),
    )

    const res = await app.request(
      "/v1/messages",
      post(MESSAGE, { authorization: `Bearer ${created.value.value}` }),
    )
    expect(res.status).toBe(200)
    // The usage row is written when the response body drains, not when the
    // headers go out, so read the body to completion before asserting on it.
    await res.text()
    await settle()
    expect(upstream.calls).toHaveLength(1)
    expect(usage.rows[0]?.accountId).toBe(ACCOUNT_IN_B)
  })
})

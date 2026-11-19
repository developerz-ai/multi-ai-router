import { afterAll, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { adminAuth } from "../../src/middleware/adminAuth"
import { errorHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import { ADMIN_KEYS_BASE_PATH, adminKeyRoutes } from "../../src/routes/admin/keys"
import { ADMIN_POOLS_BASE_PATH, adminPoolRoutes } from "../../src/routes/admin/pools"
import type { AppEnv } from "../../src/types"
import { adminMutationDatabase } from "../support/admin-mutation-database"
import { silentLogger } from "../support/silent-logger"

/**
 * multi-ai-router#453, on the incident's own path: the 2026-11-18 batch emptied a pool and revoked
 * keys through the admin token, and none of the rows it left named a caller. Pool and key writes
 * record inside a Postgres transaction, so this proves the caller survives postgres.js's transaction
 * plumbing — the in-memory store cannot.
 */

const url = process.env.DATABASE_URL ?? ""
const TOKEN = "p".repeat(48)
const fixtures: ReturnType<typeof adminMutationDatabase>[] = []

afterAll(async () => {
  for (const fixture of fixtures) await fixture.close()
})

function harness() {
  const db = adminMutationDatabase(url)
  fixtures.push(db)
  const guard = adminAuth(
    { authenticate: async () => Promise.reject(new Error("token only")), assertCsrf: () => {} },
    false,
    TOKEN,
    1,
  )
  const app = new Hono<AppEnv>()
  app.use("*", requestId())
  app.use("*", requestLogger(silentLogger()))
  app.onError(errorHandler(silentLogger(), null))
  app.route(ADMIN_POOLS_BASE_PATH, adminPoolRoutes({ guard, service: db.poolService }))
  app.route(ADMIN_KEYS_BASE_PATH, adminKeyRoutes({ guard, service: db.keyService }))
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-admin-actor": "agent ops-seat-slice02 for sebyx07",
        "x-forwarded-for": "6.6.6.6, 10.42.0.17",
        "user-agent": "dz-router-client/1",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    expect(response.status).toBeLessThan(300)
    return (await response.json()) as { id: string }
  }
  return { db, call }
}

describe.skipIf(url === "")(
  "the caller on audit rows written inside a Postgres transaction",
  () => {
    test("emptying a pool and revoking a key over HTTP both name the token holder", async () => {
      const { db, call } = harness()
      const account = await db.seedAccount()
      const pool = await call("POST", ADMIN_POOLS_BASE_PATH, {
        name: db.name("pool"),
        members: [{ accountId: account.id }],
      })
      const key = await call("POST", ADMIN_KEYS_BASE_PATH, {
        name: db.name("key"),
        scope: { kind: "pools", poolIds: [pool.id] },
      })

      await call("PATCH", `${ADMIN_POOLS_BASE_PATH}/${pool.id}`, { members: [] })
      await call("POST", `${ADMIN_KEYS_BASE_PATH}/${key.id}/revoke`)

      const rows = [
        ...(await db.audit.listForSubject(pool.id, 10)),
        ...(await db.audit.listForSubject(key.id, 10)),
      ]
      expect(rows.map((row) => row.kind).sort()).toEqual([
        "key.created",
        "key.revoked",
        "pool.created",
        "pool.updated",
      ])
      for (const row of rows) {
        expect(row).toMatchObject({
          actor: "admin-api-token",
          actorKind: "api_token",
          actorSays: "agent ops-seat-slice02 for sebyx07",
          clientIp: "10.42.0.17",
          userAgent: "dz-router-client/1",
        })
        expect(row.requestId).not.toBeNull()
      }
    })
  },
)

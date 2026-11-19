import { afterAll, describe, expect, test } from "bun:test"
import { createAuditRepository, createDatabase } from "@multi-ai-router/db"
import { Hono } from "hono"
import { adminAuth } from "../../src/middleware/adminAuth"
import { errorHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import { ADMIN_AUDIT_BASE_PATH, adminAuditRoutes } from "../../src/routes/admin/settings"
import type { AppEnv } from "../../src/types"
import { silentLogger } from "../support/silent-logger"
import { harness as settingsHarness } from "../unit/settings/fixtures"

/**
 * multi-ai-router#456: "who removed Din from the reviewer pool" is answered by one read of
 * `GET /api/admin/audit`. Driven through the real guard, the real route group and the real
 * repository over Postgres, so the `?actor=` filter is proven in SQL, before the limit — a filter
 * applied to a page afterwards would hide an actor's rows behind newer rows of anyone else.
 *
 * The table is shared with every other suite in the run, so each test names its own actors and
 * subjects with a fresh uuid and reads only those back.
 */

const url = process.env.DATABASE_URL ?? ""
const TOKEN = "f".repeat(48)
const handles: ReturnType<typeof createDatabase>[] = []

afterAll(async () => {
  for (const handle of handles) await handle.close()
})

function harness() {
  const handle = createDatabase({ url, maxConnections: 2 })
  handles.push(handle)
  const audit = createAuditRepository(handle.db)
  const { service } = settingsHarness({ auditEvents: audit })
  const guard = adminAuth(
    { authenticate: async () => Promise.reject(new Error("token only")), assertCsrf: () => {} },
    false,
    TOKEN,
    0,
  )
  const app = new Hono<AppEnv>()
  app.use("*", requestId())
  app.use("*", requestLogger(silentLogger()))
  app.onError(errorHandler(silentLogger(), null))
  app.route(ADMIN_AUDIT_BASE_PATH, adminAuditRoutes({ guard, service }))
  const get = async (query: Record<string, string>) =>
    app.request(`${ADMIN_AUDIT_BASE_PATH}?${new URLSearchParams(query).toString()}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
  return { audit, get }
}

interface FeedEvent {
  readonly id: string
  readonly kind: string
  readonly subjectId: string | null
  readonly [field: string]: unknown
}

async function events(response: Response): Promise<readonly FeedEvent[]> {
  expect(response.status).toBe(200)
  return ((await response.json()) as { events: FeedEvent[] }).events
}

describe.skipIf(url === "")("the audit feed names who made each change", () => {
  test("every event carries the six caller fields as stored", async () => {
    const { audit, get } = harness()
    const subject = crypto.randomUUID()
    await audit.append({
      kind: "pool.updated",
      subjectType: "pool",
      subjectId: subject,
      actor: "admin-api-token",
      actorKind: "api_token",
      actorSays: "agent ops-seat-slice02 for sebyx07",
      clientIp: "203.0.113.9",
      userAgent: "dz-router-client/1",
      requestId: "req-456",
    })

    const [event] = await events(await get({ subjectId: subject }))
    expect(event).toMatchObject({
      kind: "pool.updated",
      actor: "admin-api-token",
      actorKind: "api_token",
      actorSays: "agent ops-seat-slice02 for sebyx07",
      clientIp: "203.0.113.9",
      userAgent: "dz-router-client/1",
      requestId: "req-456",
    })
  })

  test("a row written before migration 0049 carries the six fields as null, never absent", async () => {
    const { audit, get } = harness()
    const subject = crypto.randomUUID()
    await audit.append({ kind: "pool.deleted", subjectType: "pool", subjectId: subject })

    const [event] = await events(await get({ subjectId: subject }))
    // The console's "not recorded" reads a null; an absent key would read as a broken response.
    for (const field of ["actor", "actorKind", "actorSays", "clientIp", "userAgent", "requestId"]) {
      expect(event).toHaveProperty(field, null)
    }
  })

  test("?actor= returns only that actor's rows, found behind newer rows of another", async () => {
    const { audit, get } = harness()
    const din = `din-${crypto.randomUUID()}@example.test`
    const other = `other-${crypto.randomUUID()}@example.test`
    await audit.append({ kind: "pool.updated", actor: din, actorKind: "session" })
    await audit.append({ kind: "key.revoked", actor: din, actorKind: "session" })
    for (let i = 0; i < 3; i++) {
      await audit.append({ kind: "pool.deleted", actor: other, actorKind: "session" })
    }

    const found = await events(await get({ actor: din, limit: "2" }))
    expect(found.map((event) => event.actor)).toEqual([din, din])
    expect(found.map((event) => event.kind)).toEqual(["key.revoked", "pool.updated"])
  })

  test("?actor= is exact: a prefix or a different case matches nothing", async () => {
    const { audit, get } = harness()
    const actor = `exact-${crypto.randomUUID()}@example.test`
    await audit.append({ kind: "pool.updated", actor, actorKind: "session" })

    expect(await events(await get({ actor: actor.slice(0, 20) }))).toEqual([])
    expect(await events(await get({ actor: actor.toUpperCase() }))).toEqual([])
    expect(await events(await get({ actor }))).toHaveLength(1)
  })

  test("?actor= with ?subjectId= narrows by both, not by the subject alone", async () => {
    const { audit, get } = harness()
    const subject = crypto.randomUUID()
    const mine = `mine-${crypto.randomUUID()}`
    await audit.append({ kind: "pool.updated", subjectId: subject, actor: mine })
    await audit.append({ kind: "pool.updated", subjectId: subject, actor: "someone-else" })

    const found = await events(await get({ subjectId: subject, actor: mine }))
    expect(found.map((event) => event.actor)).toEqual([mine])
  })

  test("?actor= with ?kind= narrows by both", async () => {
    const { audit, get } = harness()
    const actor = `both-${crypto.randomUUID()}`
    await audit.append({ kind: "pool.updated", actor })
    await audit.append({ kind: "key.revoked", actor })

    const found = await events(await get({ actor, kind: "key.revoked" }))
    expect(found.map((event) => event.kind)).toEqual(["key.revoked"])
  })

  test("an empty or over-long ?actor= is a 400, bounded like ?kind=", async () => {
    const { get } = harness()
    expect((await get({ actor: "   " })).status).toBe(400)
    expect((await get({ actor: "a".repeat(255) })).status).toBe(400)
    expect((await get({ actor: "a".repeat(254) })).status).toBe(200)
  })
})

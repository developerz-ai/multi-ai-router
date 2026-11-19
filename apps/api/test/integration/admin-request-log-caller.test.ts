import { describe, expect, test } from "bun:test"
import { AdminAuthError } from "@multi-ai-router/core"
import { Hono } from "hono"
import { createLogger } from "../../src/logging/logger"
import { adminAuth } from "../../src/middleware/adminAuth"
import { signInAuditContext } from "../../src/middleware/auditContext"
import { errorHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import { ADMIN_POOLS_BASE_PATH, adminPoolRoutes } from "../../src/routes/admin/pools"
import { createPoolsService } from "../../src/services/pools"
import type { AppEnv } from "../../src/types"
import { createMemoryStore } from "../support/memory-store"
import { silentLogger } from "../support/silent-logger"

/**
 * multi-ai-router#456: the one transport line of an admin request names its caller. On 2026-11-18
 * two `DELETE /api/admin/pools/…` calls answered 409, wrote no audit row, and logged no caller — a
 * refused change was unattributable anywhere. The data plane's lines stay exactly as they were.
 *
 * Driven through the real guard and the real pool routes over the memory store, so the 409 is the
 * route's own conflict, not a hand-thrown error.
 */

const TOKEN = "l".repeat(48)
const ACTOR = "agent ops-seat-slice02 for sebyx07"
const CLIENT = "203.0.113.9"
const NEW_FIELDS = ["actor", "actorKind", "says", "clientIp"] as const

type Line = Record<string, unknown>

function harness() {
  const lines: Line[] = []
  const log = createLogger({
    level: "debug",
    write: (line) => void lines.push(JSON.parse(line) as Line),
  })
  const store = createMemoryStore()
  // One trusted hop, so `x-forwarded-for` names the client the way it does behind the ingress.
  const guard = adminAuth(
    {
      authenticate: async () => {
        throw new AdminAuthError("no session")
      },
      assertCsrf: () => {},
    },
    false,
    TOKEN,
    1,
  )
  const app = new Hono<AppEnv>()
  app.use("*", requestId())
  app.use("*", requestLogger(log))
  app.onError(errorHandler(log, null))
  app.route(
    ADMIN_POOLS_BASE_PATH,
    adminPoolRoutes({
      guard,
      service: createPoolsService({
        logger: silentLogger(),
        mutations: store.mutations,
        onCommitted: () => {},
        pools: store.pools,
        accounts: store.accounts,
        now: () => new Date("2026-11-19T12:00:00.000Z"),
      }),
    }),
  )
  // The unguarded sign-in routes run under `signInAuditContext`; a stand-in route proves the line
  // reads that context too, without wiring the whole OIDC service.
  const signIn = new Hono<AppEnv>()
  signIn.use("*", signInAuditContext(1))
  signIn.post("/login", (c) => c.json({ error: "bad credentials" }, 401))
  app.route("/api/admin/auth", signIn)
  app.post("/v1/chat/completions", (c) => c.json({ ok: true }))
  return { app, lines }
}

async function send(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  const response = await app.request(path, {
    method,
    headers: {
      "x-forwarded-for": CLIENT,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  // The line is written when the response settles; a real client reads the body.
  await response.text()
  return response
}

function lineFor(lines: readonly Line[], method: string, path: string, status: number): Line {
  const line = lines.find(
    (candidate) =>
      (candidate.msg === "request completed" || candidate.msg === "request failed") &&
      candidate.method === method &&
      candidate.path === path &&
      candidate.status === status,
  )
  if (line === undefined) throw new Error(`no transport line for ${method} ${path} ${status}`)
  return line
}

describe("an admin request's transport line names its caller", () => {
  test("a 409 the route refused carries actor, kind, what it said and where it came from", async () => {
    const { app, lines } = harness()
    const headers = { authorization: `Bearer ${TOKEN}`, "x-admin-actor": ACTOR }
    const name = `pool-${crypto.randomUUID()}`
    expect((await send(app, "POST", ADMIN_POOLS_BASE_PATH, headers, { name })).status).toBe(201)

    const refused = await send(app, "POST", ADMIN_POOLS_BASE_PATH, headers, { name })
    expect(refused.status).toBe(409)

    expect(lineFor(lines, "POST", ADMIN_POOLS_BASE_PATH, 409)).toMatchObject({
      actor: "admin-api-token",
      actorKind: "api_token",
      says: ACTOR,
      clientIp: CLIENT,
    })
  })

  test("a request that threw after authentication fails with its caller on the line", async () => {
    const { app, lines } = harness()
    // Over the 1 MiB admin body cap: the route throws, and the error handler writes the line.
    const refused = await send(
      app,
      "POST",
      ADMIN_POOLS_BASE_PATH,
      { authorization: `Bearer ${TOKEN}`, "x-admin-actor": ACTOR },
      { name: "x".repeat(1024 * 1024 + 1) },
    )
    expect(refused.status).toBe(413)

    const line = lineFor(lines, "POST", ADMIN_POOLS_BASE_PATH, 413)
    expect(line.msg).toBe("request failed")
    expect(line).toMatchObject({
      actor: "admin-api-token",
      actorKind: "api_token",
      says: ACTOR,
      clientIp: CLIENT,
    })
  })

  test("a caller that declared no name logs no `says`, rather than a null", async () => {
    const { app, lines } = harness()
    await send(app, "GET", ADMIN_POOLS_BASE_PATH, { authorization: `Bearer ${TOKEN}` })

    const line = lineFor(lines, "GET", ADMIN_POOLS_BASE_PATH, 200)
    expect(line).toMatchObject({ actor: "admin-api-token", actorKind: "api_token" })
    expect(line).not.toHaveProperty("says")
  })

  test("a request the guard refused logs where it came from and invents no caller", async () => {
    const { app, lines } = harness()
    const refused = await send(app, "GET", ADMIN_POOLS_BASE_PATH, {
      authorization: `Bearer ${"x".repeat(48)}`,
      "x-admin-actor": ACTOR,
    })
    expect(refused.status).toBe(401)

    const line = lineFor(lines, "GET", ADMIN_POOLS_BASE_PATH, 401)
    expect(line.msg).toBe("request failed")
    expect(line.clientIp).toBe(CLIENT)
    expect(line).not.toHaveProperty("actor")
    expect(line).not.toHaveProperty("actorKind")
    // A name declared on a refused request was never accepted into a context, so it is not logged.
    expect(line).not.toHaveProperty("says")
  })

  test("a router key presented to the admin plane is refused, and still logs its address", async () => {
    const { app, lines } = harness()
    const refused = await send(app, "GET", ADMIN_POOLS_BASE_PATH, {
      authorization: "Bearer mar_live_abcdef",
    })
    expect(refused.status).toBe(401)
    expect(lineFor(lines, "GET", ADMIN_POOLS_BASE_PATH, 401).clientIp).toBe(CLIENT)
  })

  test("an unguarded sign-in attempt is logged as anonymous, from its address", async () => {
    const { app, lines } = harness()
    await send(app, "POST", "/api/admin/auth/login", { "x-admin-actor": ACTOR }, {})

    expect(lineFor(lines, "POST", "/api/admin/auth/login", 401)).toMatchObject({
      actor: "anonymous",
      actorKind: "anonymous",
      says: ACTOR,
      clientIp: CLIENT,
    })
  })
})

describe("a data-plane line is unchanged", () => {
  test("a /v1 line carries none of the caller fields, whatever the request sent", async () => {
    const { app, lines } = harness()
    await send(
      app,
      "POST",
      "/v1/chat/completions",
      { authorization: "Bearer mar_live_abcdef", "x-admin-actor": ACTOR },
      {},
    )

    const line = lineFor(lines, "POST", "/v1/chat/completions", 200)
    for (const field of NEW_FIELDS) expect(line).not.toHaveProperty(field)
  })
})

import { expect, test } from "bun:test"
import { Hono } from "hono"
import { createLogger } from "../../src/logging/logger"
import { errorHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import { type RouterKeyEnv, routerKeyAuth } from "../../src/middleware/routerKeyAuth"
import { createRouterKeyVerifier, unscopedLoader } from "../../src/services/dataplane"
import type { AppEnv } from "../../src/types"
import { apiKeyRow, cipher, clock, newRouterKey } from "../unit/dataplane/fixtures"

/**
 * 12.3 (prod 2026-10-31, Postgres restarting): a key whose cache entry had expired put the lookup
 * on the request path, and its failure rendered as a generic `500` — 52 of them in 22 minutes.
 */
test("a store outage serves a warm key stale and refuses an unknown one 503 + Retry-After, never 500", async () => {
  const key = newRouterKey()
  const testClock = clock()
  let down = false
  const verifier = createRouterKeyVerifier({
    repository: {
      findUsableByPrefix: async () => {
        if (down) throw new Error("getaddrinfo ENOTFOUND pg-production-0.pg-production")
        return [apiKeyRow(key, cipher())]
      },
    },
    loadScope: unscopedLoader,
    cipher: cipher(),
    now: testClock.now,
    cache: { ttlMs: 60_000, staleOnErrorMs: 900_000 },
  })
  const logger = createLogger({ level: "error", write: () => undefined })
  const app = new Hono<AppEnv>()
  app.use("*", requestId())
  app.use("*", requestLogger(logger, { quietPaths: [] }))
  app.onError(errorHandler(logger))
  const routes = new Hono<RouterKeyEnv>()
  routes.post("/v1/messages", routerKeyAuth(verifier), (c) => c.json({ ok: true }))
  app.route("/", routes)
  const call = (presented: string) =>
    app.request("/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${presented}` },
    })

  expect((await call(key)).status).toBe(200)
  testClock.advance(120_000)
  down = true

  expect((await call(key)).status).toBe(200)
  const unknown = await call(newRouterKey())
  expect(unknown.status).toBe(503)
  expect(unknown.headers.get("retry-after")).toBe("1")
  expect(JSON.stringify(await unknown.json())).not.toContain("pg-production")
})

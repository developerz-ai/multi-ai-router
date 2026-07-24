import { describe, expect, test } from "bun:test"
import { createDatabase } from "@multi-ai-router/db"
import { createLogger } from "../../src/logging/logger"
import { createDatabaseProbe } from "../../src/services/health/databaseProbe"

/**
 * The one test that wants a real PostgreSQL. It skips cleanly when `DATABASE_URL` is unset, so
 * the suite runs on a laptop with no database and still proves the probe against a real one in
 * CI and in compose.
 */

const databaseUrl = process.env.DATABASE_URL
const silent = createLogger({ level: "error", write: () => {} })

describe("createDatabaseProbe", () => {
  test.skipIf(databaseUrl === undefined)("pings a reachable database", async () => {
    const database = createDatabase({ url: databaseUrl ?? "", maxConnections: 1 })

    try {
      expect(await createDatabaseProbe({ handle: database, log: silent })()).toBe(true)
    } finally {
      await database.close()
    }
  })

  test("reports false — never throws — when the database is unreachable", async () => {
    const database = createDatabase({
      url: "postgres://router:router@127.0.0.1:1/router",
      maxConnections: 1,
      connectTimeoutSeconds: 1,
    })
    const probe = createDatabaseProbe({ handle: database, log: silent, timeoutMs: 500 })

    try {
      expect(await probe()).toBe(false)
    } finally {
      await database.close()
    }
  })
})

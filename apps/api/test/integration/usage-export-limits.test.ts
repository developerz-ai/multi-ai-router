import { describe, expect, test } from "bun:test"
import { createUsageRecentRepository, usageDaily } from "@multi-ai-router/db"
import { Hono } from "hono"
import {
  historyAttempt,
  historyTerminal,
  historyUrl,
  usageHistoryFixture,
} from "../../../../packages/db/test/integration/usage-history-fixture"
import type { AdminAuthEnv } from "../../src/middleware/adminAuth"
import { ADMIN_USAGE_BASE_PATH, adminUsageRoutes } from "../../src/routes/admin/usage"
import { createUsageService } from "../../src/services/usage-read"
import { USAGE_EXPORT_HEADER } from "../../src/services/usage-read/export"
import { records } from "../support/csv-sums"

/**
 * The export's refusals (issue #226): the row cap, malformed and unknown query keys, and the
 * admin guard. Split from `usage-export.test.ts` (the content tests) to stay under the file cap;
 * it seeds its own four rows, one per model, because none of these need labels.
 */
const fixture = usageHistoryFixture()
const HEADER = USAGE_EXPORT_HEADER.join(",")
const MODELS = ["m1", "m2", "m3", "m4"]

let build: (exportMaxRows: number, guard?: "open" | "closed") => Hono<AdminAuthEnv>

async function exportOf(query: string, target = build(50_000)) {
  const response = await target.request(`${ADMIN_USAGE_BASE_PATH}/export.csv?${query}`)
  return { response, text: await response.text() }
}

describe.skipIf(!historyUrl)("usage CSV export refusals", () => {
  test("seed: four rows, one per model", async () => {
    const now = Date.now()
    const attempts = MODELS.map((model, i) =>
      historyAttempt({ model, createdAt: new Date(now - (i + 1) * 60_000) }),
    )
    await fixture.usage().insertBatch({
      attempts,
      terminals: attempts.map((a) =>
        historyTerminal(a, { settledAt: new Date((a.createdAt as Date).getTime() + 1_000) }),
      ),
    })
    build = (exportMaxRows, guard = "open") => {
      const service = createUsageService({
        history: fixture.history(),
        recent: createUsageRecentRepository(fixture.db()),
        labels: async () => ({ keys: new Map(), accounts: new Map(), pools: new Map() }),
        now: () => new Date(),
        exportMaxRows,
      })
      const target = new Hono<AdminAuthEnv>()
      target.route(
        ADMIN_USAGE_BASE_PATH,
        adminUsageRoutes({
          service,
          guard:
            guard === "open"
              ? async (_c, next) => next()
              : async (c) => c.json({ error: "unauthorized" }, 401),
        }),
      )
      return target
    }
  })

  test("over the cap answers 400 naming the cap; at the cap it answers 200", async () => {
    const total = records((await exportOf("window=7d")).text).length
    expect(total).toBe(MODELS.length)
    const atCap = await exportOf("window=7d", build(total))
    expect(atCap.response.status).toBe(200)
    expect(records(atCap.text)).toHaveLength(total)
    const over = await exportOf("window=7d", build(total - 1))
    expect(over.response.status).toBe(400)
    expect(over.response.headers.get("content-type")).not.toContain("text/csv")
    expect(over.text).toContain(String(total - 1))
    expect(over.text).toContain("USAGE_EXPORT_MAX_ROWS")
    expect(over.text.includes(HEADER)).toBe(false)
  })

  test("a malformed filter or window is a 400, never a database error", async () => {
    for (const q of [
      "window=7d&keyId=nope",
      "window=7d&owner=",
      "from=nope&to=nope",
      "window=bogus",
    ]) {
      expect((await exportOf(q)).response.status).toBe(400)
    }
  })

  test("an unknown query key is a 400, as on the summary (a misspelled filter must not export everything)", async () => {
    for (const q of ["window=7d&apiKeyId=nope", "window=7d&owners=alice", "window=7d&limit=5"]) {
      const { response, text } = await exportOf(q)
      expect(response.status).toBe(400)
      expect(text.includes(HEADER)).toBe(false)
    }
    expect((await exportOf("window=7d&owner=alice")).response.status).toBe(200)
  })

  test("the admin guard covers the export: no session, no file", async () => {
    const { response, text } = await exportOf("window=7d", build(50_000, "closed"))
    expect(response.status).toBe(401)
    expect(text.includes(HEADER)).toBe(false)
  })

  test("a legacy day before the unpriced start exports an empty unpriced_attempts, not a zero", async () => {
    const sql = fixture.get().sql
    await sql.unsafe("alter table usage_daily disable trigger usage_history_baseline_seal")
    await fixture.db().insert(usageDaily).values({
      day: "1984-03-01",
      model: "legacy",
      requests: 6,
      attempts: 6,
    })
    await sql.unsafe("alter table usage_daily enable trigger usage_history_baseline_seal")
    const legacy = records(
      (await exportOf("from=1984-02-28T00:00:00.000Z&to=1984-03-05T00:00:00.000Z")).text,
    )
    expect(legacy).toHaveLength(1)
    expect(legacy[0]).toMatchObject({ day: "1984-03-01", requests: "6", unpriced_attempts: "" })
  })
})

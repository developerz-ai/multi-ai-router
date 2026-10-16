import { describe, expect, test } from "bun:test"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import type { Database } from "../../../src/client"
import { createUsageHistoryRepository } from "../../../src/repositories/usage-history-repository"

/**
 * The window-resolution step reads only the clock and the earliest retained instant. The prod
 * regression (issue #250) was that it called `coverage()` with no window, whose `pending` check is
 * an anti-join over every retained `usage_records` row against `usage_contributions` — ~half the
 * cost of a large summary, for two fields the window never reads. `clock()` is that lightweight
 * read; it must carry the earliest expression and NOT the heavy checks. Shape, not timing.
 */

function captured() {
  const queries: SQL[] = []
  const db = {
    execute: async (query: SQL) => {
      queries.push(query)
      return [{ now: new Date("2026-10-16T18:00:00.000Z"), earliest: null }]
    },
  } as unknown as Database
  return { db, render: () => new PgDialect().sqlToQuery(queries[0] as SQL).sql }
}

describe("usage history clock query", () => {
  test("clock reads the db clock and the earliest instant, nothing heavier", async () => {
    const { db, render } = captured()
    await createUsageHistoryRepository(db).clock()
    const sql = render()
    expect(sql).toContain("clock_timestamp()")
    expect(sql).toContain("least(")
    // The heavy coverage checks must not ride along on the window step.
    expect(sql).not.toContain("not exists")
    expect(sql).not.toContain('"rawFrom"')
    expect(sql).not.toContain("legacy")
  })

  test("coverage still carries the pending anti-join it is responsible for", async () => {
    const { db, render } = captured()
    await createUsageHistoryRepository(db).coverage({
      from: new Date("2026-09-16T18:42:00.000Z"),
      to: new Date("2026-10-16T18:42:00.000Z"),
    })
    const sql = render()
    // Same earliest expression as clock, plus the checks clock drops.
    expect(sql).toContain("least(")
    expect(sql).toContain("not exists")
    expect(sql).toContain('"rawFrom"')
  })
})

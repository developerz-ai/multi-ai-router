import { describe, expect, test } from "bun:test"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import type { Database } from "../../../src/client"
import { createUsageHistoryRepository } from "../../../src/repositories/usage-history-repository"
import type { UsageKeyAttribution } from "../../../src/repositories/usage-read-types"

/**
 * Issue #250 prod fingerprint, owner/tool side: the label join ran per fact row — every one of
 * ~400k window rows was hash-probed against the unnested key labels and had its bucket CASE
 * re-evaluated before the aggregate threw the grain away. The fix folds the facts to one row per
 * key (per bucket, for the series) BEFORE joining the labels, so the join and the CASE run at
 * grouped cardinality. Sums of sums are exact (numeric/bigint), so the wire rows are unchanged.
 * Shape, not timing; no database.
 */

function captured() {
  const queries: SQL[] = []
  const db = {
    execute: async (query: SQL) => {
      queries.push(query)
      return []
    },
  } as unknown as Database
  return { db, render: () => new PgDialect().sqlToQuery(queries[0] as SQL).sql }
}

const window = {
  from: new Date("2026-09-16T18:42:00.000Z"),
  to: new Date("2026-10-16T18:42:00.000Z"),
}
const attribution: UsageKeyAttribution = {
  ids: ["3f2a9c1e-0000-4000-8000-000000000001"],
  owners: ["ada"],
  ownerKinds: ["person"],
  tools: ["claude-code"],
}

describe("owner/tool reads fold the facts before the label join", () => {
  test("breakdown groups by key before joining the labels", async () => {
    const { db, render } = captured()
    await createUsageHistoryRepository(db).breakdown(window, "owner", 101, {}, attribution)
    const sql = render()
    expect(sql).toContain("group by api_key_id")
    expect(sql.indexOf("group by api_key_id")).toBeLessThan(sql.indexOf("left join"))
    // The wire contract is untouched: the bucket join, the per-dimension order and cap remain.
    expect(sql).toContain("unnest(")
    expect(sql).toContain("order by sum(tokens_in)+sum(tokens_out) desc")
    expect(sql).toContain("limit")
  })

  test("series folds by bucket and key before joining the labels", async () => {
    const { db, render } = captured()
    await createUsageHistoryRepository(db).seriesByDimension(
      window,
      "day",
      "tool",
      1,
      ["claude-code"],
      {},
      attribution,
    )
    const sql = render()
    expect(sql).toContain("date_bin")
    expect(sql.indexOf("date_bin")).toBeLessThan(sql.indexOf("left join"))
    // The fold groups before the join; the outer read re-folds to the bucket grain.
    expect(sql.indexOf("group by")).toBeLessThan(sql.indexOf("left join"))
    expect(sql).toContain("grp = any(")
  })

  test("column dimensions keep the direct single-relation grouping", async () => {
    const { db, render } = captured()
    await createUsageHistoryRepository(db).breakdown(window, "apiKeyId", 101, {})
    const sql = render()
    expect(sql).not.toContain("unnest(")
    expect(sql).toContain("group by api_key_id")
  })
})

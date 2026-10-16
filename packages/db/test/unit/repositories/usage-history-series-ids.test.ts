import { describe, expect, test } from "bun:test"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import type { Database } from "../../../src/client"
import { createUsageHistoryRepository } from "../../../src/repositories/usage-history-repository"
import type { UsageKeyAttribution } from "../../../src/repositories/usage-read-types"

/**
 * Issue #250 prod fingerprint: the per-dimension series of a column dimension bound one
 * `::text is not distinct from` term per selected id — at the 100-row breakdown cap every fact
 * row paid ~101 uuid→text casts and text comparisons after a full window scan. The fix binds the
 * ids as one typed array probe (`= any($n::uuid[])`, `::text[]` for the model column) plus an
 * explicit `is null` term for the null group. Shape, not timing; no database.
 */

function captured() {
  const queries: SQL[] = []
  const db = {
    execute: async (query: SQL) => {
      queries.push(query)
      return []
    },
  } as unknown as Database
  return { db, render: () => new PgDialect().sqlToQuery(queries[0] as SQL) }
}

const window = {
  from: new Date("2026-09-16T18:42:00.000Z"),
  to: new Date("2026-10-16T18:42:00.000Z"),
}
const keyId = "3f2a9c1e-0000-4000-8000-000000000001"
const keyId2 = "3f2a9c1e-0000-4000-8000-000000000002"
const attribution: UsageKeyAttribution = { ids: [], owners: [], ownerKinds: [], tools: [] }

describe("seriesByDimension id filter binds typed array probes", () => {
  test("a uuid dimension binds one uuid[] probe, no per-id OR-chain", async () => {
    const { db, render } = captured()
    await createUsageHistoryRepository(db).seriesByDimension(
      window,
      "day",
      "apiKeyId",
      1,
      [keyId, keyId2, null],
      {},
    )
    const { sql, params } = render()
    expect(sql).not.toContain("is not distinct from")
    expect(sql).toContain("= any(")
    expect(sql).toContain("::uuid[]")
    // The null group keeps matching: an explicit term replaces `is not distinct from null`.
    expect(sql).toContain("is null")
    // One bind carries every id; the null is not an array member.
    expect(params).toContainEqual([keyId, keyId2])
  })

  test("model binds a text[] probe", async () => {
    const { db, render } = captured()
    await createUsageHistoryRepository(db).seriesByDimension(
      window,
      "day",
      "model",
      1,
      ["claude-sonnet-5-5", null],
      {},
    )
    const { sql } = render()
    expect(sql).not.toContain("is not distinct from")
    expect(sql).toContain("= any(")
    expect(sql).toContain("::text[]")
    expect(sql).toContain("is null")
  })

  test("a null-only id list filters on is null alone", async () => {
    const { db, render } = captured()
    await createUsageHistoryRepository(db).seriesByDimension(window, "day", "poolId", 1, [null], {})
    const { sql } = render()
    expect(sql).not.toContain("is not distinct from")
    expect(sql).not.toContain("= any(")
    expect(sql).toContain("is null")
  })

  test("an empty id list still matches nothing", async () => {
    const { db, render } = captured()
    await createUsageHistoryRepository(db).seriesByDimension(window, "day", "accountId", 1, [], {})
    expect(render().sql).toContain("where false")
  })

  test("owner keeps the single grp array probe", async () => {
    const { db, render } = captured()
    await createUsageHistoryRepository(db).seriesByDimension(
      window,
      "day",
      "owner",
      1,
      ["person/ada", "#unassigned"],
      {},
      attribution,
    )
    const { sql } = render()
    expect(sql).not.toContain("is not distinct from")
    expect(sql).toContain("= any(")
    expect(sql).toContain("::text[]")
  })
})

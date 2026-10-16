import { describe, expect, test } from "bun:test"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import type { Database } from "../../../src/client"
import { createUsageReadRepository } from "../../../src/repositories/usage-read-repository"

/**
 * Issue #250 prod fingerprint, raw side: the latency breakdown narrowed to the selected group ids
 * with one `::text is not distinct from` term per id — up to ~100 text casts and comparisons per
 * retained raw row, per dimension. The fix binds one typed array probe per dimension column
 * (`= any($n::uuid[])`, `::text[]` for model) plus an explicit `is null` term for the null group.
 * Shape, not timing; no database.
 */

interface Chain extends PromiseLike<unknown[]> {
  from(source: unknown): Chain
  where(condition: SQL | undefined): Chain
  groupBy(column: unknown): Chain
  orderBy(value: unknown): Chain
  limit(count: unknown): Chain
}

function capturedBuilder() {
  let captured: SQL | undefined
  const builder = {
    from: () => builder,
    where: (condition?: SQL) => {
      captured = condition
      return builder
    },
    groupBy: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    then: (onFulfilled: (rows: unknown[]) => unknown) => Promise.resolve(onFulfilled([])),
  } as unknown as Chain
  const db = { select: () => builder } as unknown as Database
  return { db, where: () => captured }
}

const window = {
  from: new Date("2026-09-16T18:42:00.000Z"),
  to: new Date("2026-10-16T18:42:00.000Z"),
}
const keyId = "3f2a9c1e-0000-4000-8000-000000000001"
const keyId2 = "3f2a9c1e-0000-4000-8000-000000000002"

function renderWhere(captured: SQL | undefined): string {
  expect(captured).toBeDefined()
  return new PgDialect().sqlToQuery(captured as SQL).sql
}

describe("raw breakdown id filter binds typed array probes", () => {
  test("a uuid dimension binds one uuid[] probe, no per-id OR-chain", async () => {
    const { db, where } = capturedBuilder()
    await createUsageReadRepository(db).breakdown(
      window,
      "apiKeyId",
      [keyId, keyId2, null],
      100,
      {},
    )
    const sql = renderWhere(where())
    expect(sql).not.toContain("is not distinct from")
    expect(sql).toContain("= any(")
    expect(sql).toContain("::uuid[]")
    // The null group keeps matching, and the window bound still rides the same where.
    expect(sql).toContain("is null")
    expect(sql).toContain("created_at")
  })

  test("model binds a text[] probe", async () => {
    const { db, where } = capturedBuilder()
    await createUsageReadRepository(db).breakdown(window, "model", ["claude-sonnet-5-5"], 100, {})
    const sql = renderWhere(where())
    expect(sql).not.toContain("is not distinct from")
    expect(sql).toContain("::text[]")
  })

  test("a null-only id list filters on is null alone", async () => {
    const { db, where } = capturedBuilder()
    await createUsageReadRepository(db).breakdown(window, "poolId", [null], 100, {})
    const sql = renderWhere(where())
    expect(sql).not.toContain("is not distinct from")
    expect(sql).not.toContain("= any(")
    expect(sql).toContain("is null")
  })

  test("an empty id list still matches nothing", async () => {
    const { db, where } = capturedBuilder()
    await createUsageReadRepository(db).breakdown(window, "accountId", [], 100, {})
    expect(renderWhere(where())).toContain("false")
  })
})

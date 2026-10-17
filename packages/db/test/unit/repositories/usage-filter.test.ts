import { describe, expect, test } from "bun:test"
import type { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import type { Database } from "../../../src/client"
import { dimensionIdType } from "../../../src/repositories/usage-filter"
import { createUsageHistoryRepository } from "../../../src/repositories/usage-history-repository"
import { createUsageReadRepository } from "../../../src/repositories/usage-read-repository"
import type {
  UsageDimension,
  UsageKeyAttribution,
} from "../../../src/repositories/usage-read-types"

/**
 * Issue #284 item 1: the dimension-to-id-type mapping (`text` for model and the owner/tool
 * buckets, `uuid` for the column dimensions) was spelled as an inline ternary at two call
 * sites — the raw breakdown's `idsMatch` and the history `seriesQuery`. A future text
 * dimension added to one ternary and not the other binds text ids to `::uuid[]` and every
 * read of it fails with 22P02. The mapping now lives once in `usage-filter.ts`
 * (`dimensionIdType`), and this file walks every `UsageDimension` through BOTH call sites,
 * rendering their SQL and comparing the array cast each binds: the test fails the moment
 * either site disagrees with the helper or with the other. Shape, not timing; no database.
 */

// A Record over the union, so a dimension added to `UsageDimension` without a case here is a
// compile error: the walk cannot silently skip a member.
const EXPECTED: Record<UsageDimension, "text" | "uuid"> = {
  apiKeyId: "uuid",
  accountId: "uuid",
  poolId: "uuid",
  model: "text",
  owner: "text",
  tool: "text",
}

const window = {
  from: new Date("2026-09-16T18:42:00.000Z"),
  to: new Date("2026-10-16T18:42:00.000Z"),
}
const uuid1 = "3f2a9c1e-0000-4000-8000-000000000001"
const uuid2 = "3f2a9c1e-0000-4000-8000-000000000002"
const IDS: Record<UsageDimension, readonly string[]> = {
  apiKeyId: [uuid1, uuid2],
  accountId: [uuid1],
  poolId: [uuid2],
  model: ["claude-sonnet-5-5"],
  owner: ["person/ada"],
  tool: ["claude-code"],
}
const attribution: UsageKeyAttribution = { ids: [], owners: [], ownerKinds: [], tools: [] }
const dialect = new PgDialect()

/** The array type of the FIRST `= any($n::type[])` probe — the id filter, never an `unnest`. */
function probeCast(sqlText: string): "text" | "uuid" {
  const match = /= any\(\$\d+::(text|uuid)\[\]\)/.exec(sqlText)
  if (match === null) throw new Error(`no typed array probe in rendered SQL: ${sqlText}`)
  return match[1] as "text" | "uuid"
}

interface Chain extends PromiseLike<unknown[]> {
  from(source: unknown): Chain
  where(condition: SQL | undefined): Chain
  groupBy(column: unknown): Chain
  orderBy(value: unknown): Chain
  limit(count: unknown): Chain
}

/** The cast the RAW breakdown's `idsMatch` binds, rendered from its captured where. */
async function rawProbeCast(dimension: UsageDimension): Promise<"text" | "uuid"> {
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
    // biome-ignore lint/suspicious/noThenProperty: Drizzle's query chain is a thenable the repository awaits — the fake mirrors it.
    then: (onFulfilled: (rows: unknown[]) => unknown) => Promise.resolve(onFulfilled([])),
  } as unknown as Chain
  const db = { select: () => builder } as unknown as Database
  await createUsageReadRepository(db).breakdown(window, dimension, IDS[dimension], 100, {}, attribution)
  expect(captured).toBeDefined()
  return probeCast(dialect.sqlToQuery(captured as SQL).sql)
}

/** The cast the HISTORY `seriesQuery` binds, rendered from its captured statement. */
async function historyProbeCast(dimension: UsageDimension): Promise<"text" | "uuid"> {
  const queries: SQL[] = []
  const db = {
    execute: async (query: SQL) => {
      queries.push(query)
      return []
    },
  } as unknown as Database
  await createUsageHistoryRepository(db).seriesByDimension(
    window,
    "day",
    dimension,
    1,
    IDS[dimension],
    {},
    attribution,
  )
  const first = queries[0]
  expect(first).toBeDefined()
  return probeCast(dialect.sqlToQuery(first as SQL).sql)
}

describe("dimensionIdType", () => {
  for (const [dimension, expected] of Object.entries(EXPECTED) as [UsageDimension, "text" | "uuid"][])
    test(`${dimension} maps to ${expected}`, () => {
      expect(dimensionIdType(dimension)).toBe(expected)
    })
})

describe("both id-probe call sites bind the same array type per dimension", () => {
  for (const [dimension, expected] of Object.entries(EXPECTED) as [UsageDimension, "text" | "uuid"][])
    test(`${dimension}: raw breakdown and history series agree on ::${expected}[]`, async () => {
      const raw = await rawProbeCast(dimension)
      const history = await historyProbeCast(dimension)
      expect(raw).toBe(history)
      expect(raw).toBe(expected)
    })
})

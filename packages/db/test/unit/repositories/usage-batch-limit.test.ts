import { describe, expect, test } from "bun:test"
import {
  createUsageRecordRepository,
  PG_MAX_BIND_PARAMETERS,
  USAGE_RECORD_BIND_PARAMETERS_PER_ROW,
  USAGE_RECORD_MAX_BATCH_ROWS,
} from "../../../src/repositories/usage-repository"
import type { NewUsageRecordRow } from "../../../src/schema/usage-records"
import { harness } from "./fixtures"

/**
 * `USAGE_RECORD_MAX_BATCH_ROWS` is what `config/env.ts` refuses a `USAGE_BATCH_SIZE`
 * against, and the cost of it being wrong is the whole usage table: one row past
 * Postgres' bind ceiling and every flush is rejected identically, forever, with
 * traffic unaffected and nothing in the table to show for it.
 *
 * So the per-row parameter count is not taken on trust here. The statement the
 * repository would actually put on the wire is built, and its parameters counted —
 * a column added to `usage_records` and filled in by the writer turns this red on
 * the same commit, which is the only thing standing between that column and a
 * ceiling that is quietly one batch too high.
 */

const row: NewUsageRecordRow = {
  correlationId: "00000000-0000-0000-0000-000000000001",
  clientRequestId: null,
  attempt: 1,
  apiKeyId: null,
  accountId: null,
  poolId: null,
  provider: null,
  sessionKey: null,
  model: "claude-sonnet-5",
  upstreamModel: "claude-sonnet-5",
  ingressDialect: null,
  egressMode: null,
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costEstimate: null,
  costBasis: "unknown",
  latencyMs: 0,
  ttfbMs: null,
  routerOverheadMs: 0,
  outcome: "success",
  streamed: false,
  httpStatus: null,
  errorClass: null,
  createdAt: new Date("2026-06-25T00:00:00.000Z"),
}

/** Parameters the real insert statement carries for `count` rows. */
async function boundParameters(count: number): Promise<number> {
  const h = harness()
  await createUsageRecordRepository(h.db).insertMany(
    Array.from({ length: count }, () => ({ ...row })),
  )
  return h.only().params.length
}

describe("usage insert bind budget", () => {
  test("spends exactly USAGE_RECORD_BIND_PARAMETERS_PER_ROW parameters on one row", async () => {
    expect(await boundParameters(1)).toBe(USAGE_RECORD_BIND_PARAMETERS_PER_ROW)
  })

  test("scales linearly, so the ceiling is a division and not an estimate", async () => {
    expect(await boundParameters(7)).toBe(7 * USAGE_RECORD_BIND_PARAMETERS_PER_ROW)
  })

  test("emits `id` as a default rather than a parameter", async () => {
    const h = harness()
    await createUsageRecordRepository(h.db).insertMany([row])
    const { sql } = h.only()

    expect(sql).toContain('"id"')
    expect(sql).toContain("values (default, $1")
  })

  test("fits a full batch inside Postgres' bind ceiling", () => {
    expect(USAGE_RECORD_MAX_BATCH_ROWS * USAGE_RECORD_BIND_PARAMETERS_PER_ROW).toBeLessThanOrEqual(
      PG_MAX_BIND_PARAMETERS,
    )
  })

  test("is the largest batch that fits — one more row overruns", () => {
    expect(
      (USAGE_RECORD_MAX_BATCH_ROWS + 1) * USAGE_RECORD_BIND_PARAMETERS_PER_ROW,
    ).toBeGreaterThan(PG_MAX_BIND_PARAMETERS)
  })

  test("leaves room for the default batch size many times over", () => {
    // Guards the arithmetic itself: a ceiling below the shipped default would fail
    // boot on a stock configuration.
    expect(USAGE_RECORD_MAX_BATCH_ROWS).toBeGreaterThan(200)
  })
})

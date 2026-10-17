import type { SqlConnection } from "@multi-ai-router/db"
import { describe, expect, test } from "bun:test"
import {
  explainMeasures,
  type QueryMeasure,
} from "../../../bench/usage-summary-instrument"

/**
 * Issue #284 item 4: the EXPLAIN (ANALYZE, BUFFERS) parser matched `\bread=` anywhere in a
 * plan line, so a spilled node's `temp read=` was counted as shared-buffer traffic and the
 * buffers budget — the load-insensitive scan-volume gate — overcounted. The shared read must
 * be anchored on the `shared` token, the way the hit count already is. Fingerprint first: a
 * line carrying ONLY `temp read=` must add zero.
 */

function fakePlanSql(lines: readonly string[]): SqlConnection {
  return {
    unsafe: async () => lines.map((line) => ({ "QUERY PLAN": line })),
  } as unknown as SqlConnection
}

function measure(sqlText: string): QueryMeasure {
  return { name: "test", ms: 0, hit: 0, read: 0, sql: sqlText, params: [] }
}

describe("explainMeasures counts shared buffers only", () => {
  test("temp read= is not counted as a shared read", async () => {
    const m = measure("select 1")
    await explainMeasures(
      fakePlanSql(["Buffers: shared hit=100, temp read=42 written=7"]),
      [m],
    )
    expect(m.hit).toBe(100)
    expect(m.read).toBe(0)
  })

  test("a shared read beside a temp read counts the shared number", async () => {
    const m = measure("select 2")
    await explainMeasures(fakePlanSql(["Buffers: shared hit=3 read=5, temp read=42"]), [m])
    expect(m.hit).toBe(3)
    expect(m.read).toBe(5)
  })

  test("a shared read with no hit still counts", async () => {
    const m = measure("select 3")
    await explainMeasures(fakePlanSql(["Buffers: shared read=9"]), [m])
    expect(m.hit).toBe(0)
    expect(m.read).toBe(9)
  })

  test("the max across plan nodes wins, temp reads ignored", async () => {
    const m = measure("select 4")
    await explainMeasures(
      fakePlanSql(["Buffers: shared read=2", "Buffers: shared read=8, temp read=100"]),
      [m],
    )
    expect(m.read).toBe(8)
  })
})

import {
  createUsageHistoryRepository,
  type Database,
  type DatabaseHandle,
} from "@multi-ai-router/db"
import { sql } from "drizzle-orm"
import { instrument, labelCalls, type QueryMeasure } from "./usage-summary-instrument"

interface PlanNode {
  Alias?: string
  "Shared Hit Blocks"?: number
  "Shared Read Blocks"?: number
  Plans?: PlanNode[]
}

/**
 * Buffers touched by the `pending` check alone: the scan of `usage_records` (alias `r`) and the
 * per-row probes into `usage_contributions` (alias `c`). The other branches of `coverage`
 * (`legacy`, `earliest`) have their own cost that W does not move, and on this fixture they
 * dominate the statement total, so a budget on the total could not see the floor go missing.
 * Aliased nodes are relation scans; their buffer counts include any unaliased child (e.g. Bitmap Index Scan).
 */
function pendingScanBuffers(node: PlanNode): number {
  if (!hasAlias(node, "r") || !hasAlias(node, "c"))
    throw new Error(
      "bench-usage: no plan node with Alias r or c; the coverage SQL aliases changed, so a partial count would be a false pass",
    )
  return sumPendingBuffers(node)
}

function hasAlias(node: PlanNode, alias: string): boolean {
  return node.Alias === alias || (node.Plans ?? []).some((child) => hasAlias(child, alias))
}

function sumPendingBuffers(node: PlanNode): number {
  const own =
    node.Alias === "r" || node.Alias === "c"
      ? (node["Shared Hit Blocks"] ?? 0) + (node["Shared Read Blocks"] ?? 0)
      : 0
  return own + (node.Plans ?? []).reduce((sum, child) => sum + sumPendingBuffers(child), 0)
}

const ROLLBACK = Symbol("bench-usage: roll back the lifetime leg")

/**
 * The lifetime-coverage leg of `bin/bench-usage` (#275). The 30-day summary never exercises the
 * watermark floor in `coverage`'s `pending` check: that only bites on the lifetime window, whose
 * `created_at` lower bound is otherwise `-infinity`. Without the floor the check walks every
 * retained `usage_records` row (an anti-join cannot stop early); with it, only rows after W.
 *
 * The fixture's raw rows have no contributions, so this leg banks them through the real
 * `backfill` (which sets W) and then measures the lifetime `coverage()`. Everything runs inside
 * one transaction that is rolled back, so the seeded database is logically unchanged (dead row
 * versions remain until autovacuum) and `--reuse-db` stays valid. EXPLAIN runs on the same
 * connection to see the uncommitted W. The result is judged on the shared buffers of the
 * `pending` check, which host load does not distort.
 *
 * Caveat: the `ANALYZE` inside the transaction rolls back its `pg_statistic` rows, but
 * `pg_class.relpages` / `reltuples` are written in place and stay changed. Run
 * `vacuum analyze usage_records, usage_contributions` before an immediate `--reuse-db` rerun.
 */
export async function measureLifetimeCoverage(
  handle: DatabaseHandle,
): Promise<{ buffers: number; banked: number }> {
  const measures: QueryMeasure[] = []
  let banked = 0
  let pendingBuffers = 0
  try {
    await handle.db.transaction(async (tx) => {
      const db = tx as unknown as Database
      // A row with `ingested_at` adopts as `legacy_overlap`, which (correctly) refuses to certify
      // the sweep; clear it so the fixture looks like a pre-2.16 table and the sweep banks W.
      await tx.execute(sql`update usage_records set ingested_at = null`)
      // One sweep from the top of the table, short of its limit: the certifying shape.
      const result = await createUsageHistoryRepository(db).backfill({ limit: 10_000_000 })
      banked = result.processed
      if (result.remaining)
        throw new Error("bench-usage: lifetime leg did not bank the whole table")
      const [w] = await tx.execute(
        sql`select banked_through_at as at from usage_history_state where id = 'v2'`,
      )
      if (w?.at === null || w === undefined)
        throw new Error(
          "bench-usage: the sweep did not set the watermark; the leg would test nothing",
        )
      const timed = labelCalls(createUsageHistoryRepository(instrument(db, measures)), "lifetime")
      await timed.coverage()
      // The bulk UPDATE and the backfill INSERT above leave these tables without fresh
      // statistics; refresh them so the plan is the one production runs.
      await tx.execute(sql`analyze usage_records, usage_contributions`)
      const coverage = measures.find((m) => m.sql.includes("as pending"))
      if (coverage === undefined) throw new Error("bench-usage: lifetime coverage not captured")
      // Inline the bound values: this leg's own connection is the only one that sees W.
      const literal = (v: unknown) =>
        v === null || v === undefined ? "NULL" : `'${String(v).replaceAll("'", "''")}'`
      const inlined = coverage.sql.replace(/\$(\d+)/g, (_, n) =>
        literal(coverage.params[Number(n) - 1]),
      )
      const rows = await tx.execute(
        sql.raw(`explain (analyze, buffers, timing off, format json) ${inlined}`),
      )
      const root = (rows[0]?.["QUERY PLAN"] as { Plan: PlanNode }[] | undefined)?.[0]?.Plan
      if (root === undefined) throw new Error("bench-usage: no plan for lifetime coverage")
      pendingBuffers = pendingScanBuffers(root)
      throw ROLLBACK
    })
  } catch (error) {
    if (error !== ROLLBACK) throw error
  }
  return { buffers: pendingBuffers, banked }
}

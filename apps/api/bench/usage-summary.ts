import os from "node:os"
import {
  createDatabase,
  createUsageHistoryRepository,
  createUsageReadRepository,
  type Database,
  type DatabaseHandle,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { readSummary } from "../src/services/usage-read/summary"
import type { KeyLabel, UsageLabelSets } from "../src/services/usage-read/types"
import { benchUuid, ISSUE_250_SCALE, seedUsageFixture } from "./usage-summary-fixture"
import {
  explainMeasures,
  instrument,
  labelCalls,
  type QueryMeasure,
} from "./usage-summary-instrument"
import { parseArgs, USAGE, withFixtureDatabase } from "./usage-summary-lifecycle"
import { measureLifetimeCoverage } from "./usage-summary-lifetime"

/**
 * `bin/bench-usage` — the admin usage summary at issue #250's seeded size, measured
 * instead of assumed.
 *
 * The console's summary fans out to ~22 grouped reads inside one repeatable-read
 * snapshot. At the seeded size (a 30-day window over ~180k rows per v2 daily
 * rollup table plus ~200k raw records) the pre-fix build took 351.8s wall on a
 * loaded host (load ~7) — at the default `SERVER_IDLE_TIMEOUT_SECONDS` of 60 the
 * page simply dies. This leg seeds that fixture into a throwaway database, runs
 * the real `readSummary` the way the service runs it, and exits non-zero when
 * the wall clock, the total buffer traffic, or the lifetime pending-check buffers (#275) cross
 * their budget. Timings on a shared host are noisy, so the wall and buffer budgets catch
 * different regressions: the
 * wall budget catches per-row-cost blowups (an id filter regressing to a per-id
 * OR-chain quintupled the dominant statement), and the buffer budget — what
 * EXPLAIN (ANALYZE, BUFFERS) reports, which load does not distort — catches
 * scan-volume blowups (a lost day bound, a dropped rollup). The default wall budget is the
 * operator's idle bound itself (60 s, #284): a summary this bench passes must also survive
 * `SERVER_IDLE_TIMEOUT_SECONDS`. A loaded host inflates the wall leg, so raise `--budget-ms`
 * there and read the buffers leg — load-insensitive — as the gate. The per-query table it
 * prints is what a PR records.
 *
 * Deliberately not part of `bin/check`, for the same reason `bin/bench` is not: a
 * timing measurement on a shared runner is a flaky test. Run it when you touch
 * `usage-read`, the usage repositories, or their indexes.
 *
 * The database lifecycle is gated (#283, #286): a run drops only a database it
 * created — ownership beginning when `create database` succeeds, never at the
 * `pg_database` probe — or one `--drop-existing` authorized, and a pre-existing
 * `--db` name is refused untouched without `--reuse-db` or `--drop-existing`. The
 * gates and their ordering live, pure and injected-executor tested, in
 * `usage-summary-lifecycle.ts`.
 */

async function hasRawRows(sql: DatabaseHandle["sql"]): Promise<boolean> {
  const [row] = await sql`select exists (select 1 from usage_records) as present`
  return row?.present === true
}

function buildLabels(keys: number): UsageLabelSets {
  const keyLabels = new Map<string, KeyLabel>()
  for (let k = 0; k < keys; k++)
    keyLabels.set(benchUuid(k), {
      name: `key-${k}`,
      owner: `owner-${k % 50}`,
      ownerKind: k % 2 === 0 ? "person" : "service",
      tool: k % 7 === 0 ? null : `tool-${k % 10}`,
      retired: false,
      prefix: "sk-bench",
    })
  const accounts = new Map<string, string>()
  for (let i = 0; i < 6; i++) accounts.set(benchUuid(10_000 + i), `account-${i}`)
  const pools = new Map<string, string>()
  for (let i = 0; i < 3; i++) pools.set(benchUuid(20_000 + i), `pool-${i}`)
  return { keys: keyLabels, accounts, pools }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes("--help")) {
    console.log(USAGE)
    return
  }
  const options = parseArgs(argv)
  if (options.url === "") throw new Error("DATABASE_URL (or --url) is required")
  if (options.dbName !== undefined && !/^[a-z][a-z0-9_]*$/.test(options.dbName))
    throw new Error("--db must be a plain lowercase identifier")
  const base = new URL(options.url)
  const name =
    options.dbName ?? `usage_bench_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
  const fixtureUrl = new URL(base)
  fixtureUrl.pathname = `/${name}`

  const admin = createDatabase({ url: base.toString(), maxConnections: 1 })
  try {
    // The whole destroy-decision sequence — probe, gate, create, exit drop — lives in
    // `withFixtureDatabase` so it is testable against an injected executor (#286).
    await withFixtureDatabase({
      sql: admin.sql,
      name,
      reuseDb: options.reuseDb,
      dropExisting: options.dropExisting,
      keepDb: options.keepDb,
      body: async (mode) => {
        // Migrations always run: idempotent, and a reused database may predate a new one.
        await runMigrations({
          url: fixtureUrl.toString(),
          migrationsFolder: defaultMigrationsFolder(),
        })
        const handle = createDatabase({ url: fixtureUrl.toString(), maxConnections: 4 })
        try {
          let keys = ISSUE_250_SCALE.v2RowsPerDay / 8
          if (mode === "seed") {
            const seeded = await seedUsageFixture(handle.sql, ISSUE_250_SCALE)
            keys = seeded.keys
            console.log(
              `fixture: ${ISSUE_250_SCALE.days}d window, ${seeded.keys} keys, ` +
                `${(seeded.keys * 8 * (ISSUE_250_SCALE.days - 1)).toLocaleString()} rows per rollup table, ` +
                `${ISSUE_250_SCALE.rawRows.toLocaleString()} raw, ` +
                `${ISSUE_250_SCALE.contributionRows.toLocaleString()} contributions`,
            )
          } else {
            console.log(`fixture: reusing seeded database "${name}" (seed untouched)`)
          }
          console.log(
            `loadavg: ${os
              .loadavg()
              .map((x) => x.toFixed(1))
              .join(" ")}`,
          )

          const measures: QueryMeasure[] = []
          const labels = buildLabels(keys)
          let wall = 0
          await handle.db.transaction(
            async (tx) => {
              const instrumented = instrument(tx as unknown as Database, measures)
              const history = labelCalls(createUsageHistoryRepository(instrumented), "history")
              const raw = labelCalls(createUsageReadRepository(instrumented), "raw")
              const t0 = performance.now()
              await readSummary(
                { history, raw, labels, now: () => new Date() },
                { window: "30d" },
                {},
              )
              // The wall is the summary's own cost; the explain pass below is measurement, not product.
              wall = performance.now() - t0
              if (options.explain) {
                const explainMs = await explainMeasures(handle.sql, measures)
                console.log(
                  `explain pass: ${(explainMs / 1000).toFixed(0)}s (not part of the wall budget)`,
                )
              }
            },
            { isolationLevel: "repeatable read", accessMode: "read only" },
          )

          const byName = new Map<string, QueryMeasure & { queries: number }>()
          for (const m of measures) {
            const agg = byName.get(m.name) ?? { ...m, queries: 0, ms: 0, hit: 0, read: 0 }
            agg.queries += 1
            agg.ms += m.ms
            agg.hit += m.hit
            agg.read += m.read
            byName.set(m.name, agg)
          }
          console.log("\nquery                    | queries | ms     | shared hit | shared read")
          for (const [name2, m] of [...byName.entries()].sort((a, b) => b[1].ms - a[1].ms))
            console.log(
              `${name2.padEnd(24)} | ${String(m.queries).padStart(7)} | ${m.ms.toFixed(0).padStart(6)} | ` +
                `${String(m.hit).padStart(10)} | ${String(m.read).padStart(11)}`,
            )
          const buffers = measures.reduce((sum, m) => sum + m.hit + m.read, 0)
          const failures: string[] = []
          if (wall > options.budgetMs)
            failures.push(`summary wall ${wall.toFixed(0)}ms over budget ${options.budgetMs}ms`)
          if (buffers > options.buffersBudget)
            failures.push(`shared buffers ${buffers} over budget ${options.buffersBudget}`)
          console.log(
            `\nsummary: ${wall.toFixed(0)}ms (budget ${options.budgetMs}ms) ` +
              `${wall > options.budgetMs ? "FAIL" : "ok"}; ` +
              `buffers: ${buffers} (budget ${options.buffersBudget}) ` +
              `${buffers > options.buffersBudget ? "FAIL" : "ok"}`,
          )
          // The lifetime leg (#275): bank the fixture through the real backfill so W is set, then
          // measure the lifetime coverage. Rolled back, so the seed is untouched.
          if (!options.explain) {
            console.log("lifetime leg skipped (--no-explain)")
          } else if (!(await hasRawRows(handle.sql))) {
            console.log("lifetime leg skipped: no raw rows")
          } else {
            const lifetime = await measureLifetimeCoverage(handle)
            console.log(
              `lifetime coverage: banked ${lifetime.banked.toLocaleString()} rows (rolled back); ` +
                `pending-check buffers: ${lifetime.buffers} (budget ${options.lifetimeBuffersBudget}) ` +
                `${lifetime.buffers > options.lifetimeBuffersBudget ? "FAIL" : "ok"}`,
            )
            if (lifetime.buffers > options.lifetimeBuffersBudget)
              failures.push(
                `lifetime pending-check buffers ${lifetime.buffers} over budget ${options.lifetimeBuffersBudget}`,
              )
          }
          if (failures.length > 0) {
            console.error(`bench-usage: FAIL — ${failures.join("; ")}`)
            process.exitCode = 1
          }
          if (options.keepDb)
            console.log(`kept database: ${fixtureUrl.toString().replace(/:\/\/.*@/, "://***@")}`)
        } finally {
          // Closed before the lifecycle's exit drop so no connection of this run is
          // inside the database when it goes.
          await handle.close()
        }
      },
    })
  } finally {
    await admin.close()
  }
}

await main()

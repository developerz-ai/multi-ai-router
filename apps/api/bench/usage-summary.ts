import os from "node:os"
import {
  createDatabase,
  createUsageHistoryRepository,
  createUsageReadRepository,
  type Database,
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
 * either the wall clock or the total buffer traffic crosses its budget. Timings
 * on a shared host are noisy, so the two budgets catch different regressions: the
 * wall budget catches per-row-cost blowups (an id filter regressing to a per-id
 * OR-chain quintupled the dominant statement), and the buffer budget — what
 * EXPLAIN (ANALYZE, BUFFERS) reports, which load does not distort — catches
 * scan-volume blowups (a lost day bound, a dropped rollup). The per-query table
 * it prints is what a PR records.
 *
 * Deliberately not part of `bin/check`, for the same reason `bin/bench` is not: a
 * timing measurement on a shared runner is a flaky test. Run it when you touch
 * `usage-read`, the usage repositories, or their indexes.
 */

interface Options {
  url: string
  budgetMs: number
  buffersBudget: number
  explain: boolean
  keepDb: boolean
  dbName: string | undefined
  reuseDb: boolean
}

const DEFAULTS: Options = {
  url: process.env.DATABASE_URL ?? "",
  budgetMs: 240_000,
  buffersBudget: 1_200_000,
  explain: true,
  keepDb: false,
  dbName: undefined,
  reuseDb: false,
}

function parseArgs(argv: string[]): Options {
  const options = { ...DEFAULTS }
  const numberFlag = (name: string, set: (v: number) => void) => {
    const at = argv.indexOf(name)
    if (at === -1) return
    const raw = argv[at + 1]
    if (raw === undefined || Number.isNaN(Number(raw))) throw new Error(`${name} needs a number`)
    set(Number(raw))
  }
  const stringFlag = (name: string, set: (v: string) => void) => {
    const at = argv.indexOf(name)
    if (at === -1) return
    const raw = argv[at + 1]
    if (raw === undefined) throw new Error(`${name} needs a value`)
    set(raw)
  }
  numberFlag("--budget-ms", (v) => (options.budgetMs = v))
  numberFlag("--buffers-budget", (v) => (options.buffersBudget = v))
  stringFlag("--url", (v) => (options.url = v))
  stringFlag("--db", (v) => (options.dbName = v))
  options.reuseDb = argv.includes("--reuse-db")
  options.keepDb = argv.includes("--keep-db")
  options.explain = !argv.includes("--no-explain")
  return options
}

const USAGE = `Usage: bin/bench-usage [options]

  --url URL              admin database URL; a throwaway database is created beside it
  --db NAME              name the throwaway database (default: a random usage_bench_*)
  --reuse-db             keep an existing --db database's seed; only re-run migrations
  --budget-ms N          wall budget for one summary      (default ${DEFAULTS.budgetMs})
  --buffers-budget N     shared-buffer budget, all queries (default ${DEFAULTS.buffersBudget})
  --no-explain           skip the EXPLAIN pass, buffers, and the per-query table
  --keep-db              keep the throwaway database (prints its URL)
`

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
  let handle: Awaited<ReturnType<typeof createDatabase>> | undefined
  try {
    const existing = await admin.sql.unsafe("select 1 from pg_database where datname = $1", [name])
    const fresh = existing.length === 0
    if (fresh) await admin.sql.unsafe(`create database "${name}"`)
    // Migrations always run: idempotent, and a reused database may predate a new one.
    await runMigrations({ url: fixtureUrl.toString(), migrationsFolder: defaultMigrationsFolder() })
    handle = createDatabase({ url: fixtureUrl.toString(), maxConnections: 4 })
    let keys = ISSUE_250_SCALE.v2RowsPerDay / 8
    if (fresh || !options.reuseDb) {
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
        await readSummary({ history, raw, labels, now: () => new Date() }, { window: "30d" }, {})
        // The wall is the summary's own cost; the explain pass below is measurement, not product.
        wall = performance.now() - t0
        if (options.explain) {
          const explainMs = await explainMeasures(handle?.sql ?? admin.sql, measures)
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
    if (failures.length > 0) {
      console.error(`bench-usage: FAIL — ${failures.join("; ")}`)
      process.exitCode = 1
    }
    if (options.keepDb)
      console.log(`kept database: ${fixtureUrl.toString().replace(/:\/\/.*@/, "://***@")}`)
  } finally {
    await handle?.close()
    if (!options.keepDb) {
      try {
        await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
      } catch {
        // The drop is best-effort cleanup; the verdict above is what matters.
      }
    }
    await admin.close()
  }
}

await main()

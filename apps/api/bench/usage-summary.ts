import { AsyncLocalStorage } from "node:async_hooks"
import os from "node:os"
import {
  createDatabase,
  createUsageHistoryRepository,
  createUsageReadRepository,
  type Database,
  defaultMigrationsFolder,
  runMigrations,
  type SqlConnection,
} from "@multi-ai-router/db"
import { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { readSummary } from "../src/services/usage-read/summary"
import type { KeyLabel, UsageLabelSets } from "../src/services/usage-read/types"
import { benchUuid, ISSUE_250_SCALE, seedUsageFixture } from "./usage-summary-fixture"

/**
 * `bin/bench-usage` — the admin usage summary at issue #250's seeded size, measured
 * instead of assumed.
 *
 * The console's summary fans out to ~22 grouped reads inside one repeatable-read
 * snapshot. At the seeded size (a 30-day window over ~180k rows per daily rollup
 * table plus ~200k raw records) the pre-fix build took ~60-80s on a loaded host —
 * at the default `SERVER_IDLE_TIMEOUT_SECONDS` of 60 the page simply dies. This leg
 * seeds that fixture into a throwaway database, runs the real `readSummary` the way
 * the service runs it, and exits non-zero when either the wall clock or the total
 * buffer traffic crosses its budget. Timings on a shared host are noisy, so the
 * buffer budget — what EXPLAIN (ANALYZE, BUFFERS) reports, which load does not
 * distort — is the gate that fails on a large regression; `--explain` prints the
 * per-query table for a PR.
 *
 * The measurement is two-phase on purpose: phase one times the untouched summary,
 * phase two re-runs each distinct statement under EXPLAIN (ANALYZE, BUFFERS) for
 * buffer counts. Folding the explain into the timed pass double-executes every
 * query and the "subtract the explain overhead" arithmetic goes negative on a
 * loaded host.
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
}

const DEFAULTS: Options = {
  url: process.env.DATABASE_URL ?? "",
  budgetMs: 15_000,
  buffersBudget: 250_000,
  explain: true,
  keepDb: false,
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
  numberFlag("--budget-ms", (v) => (options.budgetMs = v))
  numberFlag("--buffers-budget", (v) => (options.buffersBudget = v))
  const at = argv.indexOf("--url")
  if (at !== -1) {
    const raw = argv[at + 1]
    if (raw === undefined) throw new Error("--url needs a value")
    options.url = raw
  }
  options.keepDb = argv.includes("--keep-db")
  options.explain = !argv.includes("--no-explain")
  return options
}

const USAGE = `Usage: bin/bench-usage [options]

  --url URL              admin database URL; a throwaway database is created beside it
  --budget-ms N          wall budget for one summary      (default ${DEFAULTS.budgetMs})
  --buffers-budget N     shared-buffer budget, all queries (default ${DEFAULTS.buffersBudget})
  --no-explain           skip the EXPLAIN pass, buffers, and the per-query table
  --keep-db              keep the throwaway database (prints its URL)
`

interface QueryMeasure {
  name: string
  ms: number
  hit: number
  read: number
  sql: string
  params: unknown[]
}

const dialect = new PgDialect()
const label = new AsyncLocalStorage<string>()

function serializeParam(v: unknown): unknown {
  if (Array.isArray(v))
    return `{${v.map((x) => (x === null ? "null" : `"${String(x).replace(/["\\]/g, "\\$&")}"`)).join(",")}}`
  if (v instanceof Date) return v.toISOString()
  return v as unknown
}

function compile(query: unknown): { sql: string; params: unknown[] } {
  if (query instanceof SQL) return dialect.sqlToQuery(query)
  if (typeof query === "object" && query !== null && "toSQL" in query)
    return (query as { toSQL(): { sql: string; params: unknown[] } }).toSQL()
  throw new Error("bench-usage: uncompilable query")
}

/**
 * Wraps a db handle so every read is timed. The label is captured when a statement
 * is created (inside the repo call's `label.run`), not when it is awaited: the
 * await can run in a context the AsyncLocalStorage no longer reaches.
 */
function instrument(db: Database, measures: QueryMeasure[]): Database {
  const record = (name: string, query: unknown, run: () => Promise<unknown>) => {
    const compiled = compile(query)
    const t0 = performance.now()
    return run().then((result) => {
      measures.push({
        name,
        ms: performance.now() - t0,
        hit: 0,
        read: 0,
        sql: compiled.sql,
        params: compiled.params,
      })
      return result
    })
  }
  const wrapBuilder = (builder: object, name: string): object =>
    new Proxy(builder, {
      get(target, prop, receiver) {
        if (prop === "then")
          return (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
            record(name, target, () => Promise.resolve(target as PromiseLike<unknown>)).then(
              onF,
              onR,
            )
        const value = Reflect.get(target, prop, receiver)
        if (typeof value === "function")
          return (...args: unknown[]) => {
            const next = value.apply(target, args)
            return next !== null && typeof next === "object" && "then" in next
              ? wrapBuilder(next, name)
              : next
          }
        return value
      },
    })
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "execute")
        return (query: unknown) => {
          const name = label.getStore() ?? "unknown"
          return record(name, query, () => (target as Database).execute(query as SQL<unknown>))
        }
      if (prop === "select") {
        const select = Reflect.get(target, prop, receiver) as (...args: unknown[]) => unknown
        return (...args: unknown[]) => {
          const name = label.getStore() ?? "unknown"
          const next = select.apply(target, args)
          return next !== null && typeof next === "object" ? wrapBuilder(next, name) : next
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as Database
}

/** Phase two: re-run each distinct statement under EXPLAIN for its buffer counts. */
async function explainMeasures(sql: SqlConnection, measures: QueryMeasure[]): Promise<number> {
  const seen = new Set<string>()
  let explainedMs = 0
  for (const measure of measures) {
    if (seen.has(measure.sql)) continue
    seen.add(measure.sql)
    const t0 = performance.now()
    const plan = await sql.unsafe(
      `explain (analyze, buffers, costs off, timing off, summary off) ${measure.sql}`,
      measure.params.map(serializeParam),
    )
    explainedMs += performance.now() - t0
    for (const row of plan) {
      const line = row["QUERY PLAN"] as string
      const hit = /shared hit=(\d+)/.exec(line)
      const read = /\bread=(\d+)/.exec(line)
      if (hit) measure.hit = Math.max(measure.hit, Number(hit[1]))
      if (read) measure.read = Math.max(measure.read, Number(read[1]))
    }
    // The same statement text may have been recorded under several labels (a breakdown
    // and its series-by share none, but a totals and a coverage could); fill them all.
    for (const other of measures)
      if (other.sql === measure.sql) {
        other.hit = measure.hit
        other.read = measure.read
      }
  }
  return explainedMs
}

function labelCalls<T extends object>(repo: T, prefix: string): T {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== "function") return value
      return (...args: unknown[]) => {
        const dim =
          prop === "breakdown" || prop === "breakdowns"
            ? args[1]
            : prop === "seriesByDimension"
              ? args[2]
              : undefined
        const name = dim !== undefined ? `${prefix}:${String(dim)}` : `${prefix}.${String(prop)}`
        return label.run(name, () => (value as (...a: unknown[]) => unknown).apply(target, args))
      }
    },
  }) as T
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
  const base = new URL(options.url)
  const name = `usage_bench_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
  const fixtureUrl = new URL(base)
  fixtureUrl.pathname = `/${name}`

  const admin = createDatabase({ url: base.toString(), maxConnections: 1 })
  let handle: Awaited<ReturnType<typeof createDatabase>> | undefined
  try {
    await admin.sql.unsafe(`create database "${name}"`)
    await runMigrations({ url: fixtureUrl.toString(), migrationsFolder: defaultMigrationsFolder() })
    handle = createDatabase({ url: fixtureUrl.toString(), maxConnections: 4 })
    const seeded = await seedUsageFixture(handle.sql, ISSUE_250_SCALE)
    console.log(
      `fixture: ${ISSUE_250_SCALE.days}d window, ${seeded.keys} keys, ` +
        `${(seeded.keys * 8 * (ISSUE_250_SCALE.days - 1)).toLocaleString()} rows per rollup table, ` +
        `${ISSUE_250_SCALE.rawRows.toLocaleString()} raw, ` +
        `${ISSUE_250_SCALE.contributionRows.toLocaleString()} contributions`,
    )
    console.log(
      `loadavg: ${os
        .loadavg()
        .map((x) => x.toFixed(1))
        .join(" ")}`,
    )

    const measures: QueryMeasure[] = []
    const labels = buildLabels(seeded.keys)
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
    for (const [name, m] of [...byName.entries()].sort((a, b) => b[1].ms - a[1].ms))
      console.log(
        `${name.padEnd(24)} | ${String(m.queries).padStart(7)} | ${m.ms.toFixed(0).padStart(6)} | ` +
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

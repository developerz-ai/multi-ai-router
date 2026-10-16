import { AsyncLocalStorage } from "node:async_hooks"
import type { Database, SqlConnection } from "@multi-ai-router/db"
import { SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"

/**
 * Per-query instrumentation for `bin/bench-usage`. Split from the runner so both
 * files stay readable top to bottom: this one answers "which statement cost what",
 * the runner answers "does the summary fit its budget".
 *
 * The measurement is two-phase on purpose: phase one times the untouched summary,
 * phase two re-runs each distinct statement under EXPLAIN (ANALYZE, BUFFERS) for
 * buffer counts. Folding the explain into the timed pass double-executes every
 * query and the "subtract the explain overhead" arithmetic goes negative on a
 * loaded host.
 */

export interface QueryMeasure {
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
export function instrument(db: Database, measures: QueryMeasure[]): Database {
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
export async function explainMeasures(
  sql: SqlConnection,
  measures: QueryMeasure[],
): Promise<number> {
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

/** Labels every statement a repository method issues with the method (and dimension) name. */
export function labelCalls<T extends object>(repo: T, prefix: string): T {
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

/**
 * The `bin/bench-usage` command line and its database lifecycle gates — the two
 * decisions about what a run may destroy, kept pure so the truth table is testable
 * without a database, and the argument parser kept out of `usage-summary.ts` so
 * importing it never runs the bench.
 *
 * Issue #283: the harness used to seed (truncating the usage tables first) and then
 * `finally`-drop whatever database `--db` named, so pointing a run at a real database
 * destroyed it without confirmation. A run may now destroy only a database it created
 * itself (`fresh`); a pre-existing one needs an explicit flag — `--reuse-db` to
 * benchmark its seed as-is, `--drop-existing` to authorize reseeding and dropping it.
 * Deliberately a flag, not a prompt: `bin/bench-usage` runs unattended in scripts.
 *
 * Issue #286: `withFixtureDatabase` sequences probe → gate → create → body → exit
 * drop against an injected executor, and ownership begins at a *successful* create,
 * never at the probe. Both flags together are not a conflict but a composition:
 * `--reuse-db` wins the seed decision, `--drop-existing` still authorizes the exit
 * drop — documented in `USAGE` and pinned in the truth table.
 */

export interface Options {
  url: string
  budgetMs: number
  buffersBudget: number
  explain: boolean
  keepDb: boolean
  dbName: string | undefined
  reuseDb: boolean
  dropExisting: boolean
}

export const DEFAULTS: Options = {
  url: process.env.DATABASE_URL ?? "",
  budgetMs: 240_000,
  buffersBudget: 1_200_000,
  explain: true,
  keepDb: false,
  dbName: undefined,
  reuseDb: false,
  dropExisting: false,
}

export function parseArgs(argv: string[]): Options {
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
  options.dropExisting = argv.includes("--drop-existing")
  options.keepDb = argv.includes("--keep-db")
  options.explain = !argv.includes("--no-explain")
  return options
}

export const USAGE = `Usage: bin/bench-usage [options]

  --url URL              admin database URL; a throwaway database is created beside it
  --db NAME              name the throwaway database (default: a random usage_bench_*)
  --reuse-db             keep an existing --db database's seed; only re-run migrations;
                         together with --drop-existing this wins the seed decision
  --drop-existing        on a --db database that already exists when this run probes it:
                         reseed it, and drop it at the end — a name created only after the
                         probe is never dropped; together with --reuse-db the seed is kept
                         and the database is still dropped at exit
  --budget-ms N          wall budget for one summary      (default ${DEFAULTS.budgetMs})
  --buffers-budget N     shared-buffer budget, all queries (default ${DEFAULTS.buffersBudget})
  --no-explain           skip the EXPLAIN pass, buffers, and the per-query table
  --keep-db              keep the throwaway database (prints its URL)
`

/** What the run does with the database `--db` names, before it touches anything. */
export type FixtureMode = "seed" | "reuse" | "refuse"

/**
 * `fresh` seeds by definition — the run is about to create it. A pre-existing
 * database seeds only under `--drop-existing`, is benchmarked as-is under
 * `--reuse-db`, and is refused with no flag at all: an unnamed authorization is
 * exactly what destroyed the database in #283. Both flags together: `--reuse-db`
 * wins the seed decision, `--drop-existing` still authorizes the exit drop
 * (`dropsOnExit`) — the precedence is documented in `USAGE` and pinned in the
 * truth table (#286).
 */
export function fixtureMode(gates: {
  fresh: boolean
  reuseDb: boolean
  dropExisting: boolean
}): FixtureMode {
  if (gates.fresh) return "seed"
  if (gates.reuseDb) return "reuse"
  if (gates.dropExisting) return "seed"
  return "refuse"
}

/**
 * The `finally` block's drop gate. A run drops a database it created (`fresh`), or
 * one `--drop-existing` authorized — never any other pre-existing database, whatever
 * failed along the way. `--keep-db` keeps even those. The `dropExisting` input is
 * the flag *bound to the probe*: callers pass it only for a database that existed
 * at the probe, so a name that appeared afterwards (a raced create) is outside the
 * authorization (#286).
 */
export function dropsOnExit(gates: {
  fresh: boolean
  dropExisting: boolean
  keepDb: boolean
}): boolean {
  return !gates.keepDb && (gates.fresh || gates.dropExisting)
}

/** The refusal, naming the database and both explicit ways forward. */
export function existingDbRefusal(name: string): string {
  return (
    `database "${name}" already exists and this run was not told it may touch it — ` +
    "pass --reuse-db to benchmark its existing seed as-is, " +
    "or --drop-existing to reseed it and drop it at the end"
  )
}

/**
 * The admin-executor face the lifecycle uses: probe, create, drop — nothing else.
 * Injected so the whole destroy-decision sequence is testable without a database,
 * the same way the gates above are (#286).
 */
export interface LifecycleSql {
  unsafe(query: string, params?: string[]): Promise<unknown[]>
}

/**
 * The full database lifecycle around a bench body: probe the name, gate
 * (refuse / reuse / seed), create when the probe found nothing, run the body,
 * and drop in the `finally` only what the exit gate still owns. The refusal
 * fires before create and before migrations — a refused database is not
 * touched at all.
 *
 * #286: the drop gate's `fresh` becomes true only after `create database`
 * succeeded. A name another actor creates between the probe and the create
 * fails the create; that database belongs to whoever created it, and the
 * `finally` must read it as "not ours" — `--drop-existing` authorizes only a
 * database that existed at the probe, so the exit gate receives the flag bound
 * to the probe (`dropExisting && !absentAtProbe`), never the raw flag.
 */
export async function withFixtureDatabase<T>(deps: {
  sql: LifecycleSql
  name: string
  reuseDb: boolean
  dropExisting: boolean
  keepDb: boolean
  body: (mode: FixtureMode) => Promise<T>
}): Promise<T> {
  const rows = await deps.sql.unsafe("select 1 from pg_database where datname = $1", [deps.name])
  const absentAtProbe = rows.length === 0
  const mode = fixtureMode({
    fresh: absentAtProbe,
    reuseDb: deps.reuseDb,
    dropExisting: deps.dropExisting,
  })
  if (mode === "refuse") throw new Error(existingDbRefusal(deps.name))
  let fresh = false
  try {
    if (absentAtProbe) {
      await deps.sql.unsafe(`create database "${deps.name}"`)
      fresh = true
    }
    return await deps.body(mode)
  } finally {
    // The flag authorizes a database that existed at the probe; a name this run's
    // create failed on appeared afterwards and belongs to whoever created it (#286).
    const dropExisting = deps.dropExisting && !absentAtProbe
    if (dropsOnExit({ fresh, dropExisting, keepDb: deps.keepDb })) {
      try {
        await deps.sql.unsafe(`drop database if exists "${deps.name}" with (force)`)
      } catch {
        // The drop is best-effort cleanup; the body's verdict is what matters.
      }
    }
  }
}

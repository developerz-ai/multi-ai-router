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
  --reuse-db             keep an existing --db database's seed; only re-run migrations
  --drop-existing        on a pre-existing --db database: reseed it, and drop it at the end
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
 * exactly what destroyed the database in #283.
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
 * failed along the way. `--keep-db` keeps even those.
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

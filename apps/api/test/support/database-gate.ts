/**
 * Decides whether a `bun test` run is allowed to proceed without a database.
 *
 * Seven suites gate themselves on `DATABASE_URL` — migrations apply cleanly,
 * advisory-lock leader election admits exactly one holder (non-negotiable 13),
 * retention deletes stay bounded, the readiness probe answers a real database —
 * and `bun test` folds a skip into the same green summary as a pass. A run that
 * proved strictly less than CI looks exactly like one that proved more, which is
 * what `bin/check`'s promise ("if it passes here it passes on the PR") forbids.
 *
 * A shell pre-check cannot own this decision, because the shell and the test
 * process do not resolve the variable the same way. `bun test` always loads
 * `.env.test` and never loads `.env.local`; a plain `bun` invocation does the
 * opposite. So a `.env.test` that blanks `DATABASE_URL` sails past a `bun -e`
 * pre-check and then skips every suite — silently, which is the bug. The verdict
 * therefore has to be reached inside the run, from the same `process.env` the
 * suites themselves read. `bin/lib/database-url` keeps the shell's *advisory*
 * copy honest; this is the one that is authoritative.
 *
 * Pure on purpose: `database-gate-preload.ts` owns the exit, this owns the
 * decision, so the decision is testable without taking one.
 */

/** The slice of the environment the verdict turns on. */
export interface DatabaseGateEnv {
  readonly DATABASE_URL?: string | undefined
  readonly CI?: string | undefined
  readonly ROUTER_TEST_REQUIRE_DATABASE?: string | undefined
}

/**
 * What a run without a database leaves unproven. Written as claims rather than
 * filenames: `bin/test` names the files (it derives them from the tree, so the
 * list cannot go stale), and this message is read by someone who needs to know
 * what coverage they lost, not which paths to open.
 */
const UNPROVEN = [
  "migrations apply cleanly against PostgreSQL 16",
  "advisory-lock leader election admits exactly one holder",
  "retention deletes stay bounded to their batch limit",
  "the readiness probe answers against a real database",
]

const REMEDY = [
  "bin/setup                  starts the dev Postgres and writes DATABASE_URL to .env",
  "DATABASE_URL=… bin/check   point at a Postgres 16+ you already run",
]

/**
 * `bun test` reads `.env.test` and ignores `.env.local` — the reverse of every
 * other `bun` invocation. Someone staring at a `DATABASE_URL` that is plainly
 * there needs to be told which file the run actually read, or they conclude the
 * gate is broken and reach for a way around it.
 */
const RESOLUTION_NOTE =
  "`bun test` reads .env / .env.test and ignores .env.local. A DATABASE_URL set only in\n" +
  ".env.local — or blanked in .env.test — is not the value this run sees. `bin/lib/database-url`\n" +
  "prints the one it does."

/** Empty and unset are the same thing: neither one connects. */
function present(value: string | undefined): boolean {
  return value !== undefined && value !== ""
}

/**
 * True when this run promised a database. CI because a green run there is what a
 * merge is decided on; the flag because `bin/check` makes the same promise
 * locally. A bare `bin/test` promises nothing — it is the loop you use on a
 * laptop with no Docker — and only gets the warning `bin/test` prints itself.
 */
export function databaseRequired(env: DatabaseGateEnv): boolean {
  return present(env.CI) || env.ROUTER_TEST_REQUIRE_DATABASE === "1"
}

/** The refusal to print, or `null` when the run may go ahead. */
export function databaseGateRefusal(env: DatabaseGateEnv): string | null {
  if (!databaseRequired(env)) return null
  if (present(env.DATABASE_URL)) return null

  const reason = present(env.CI)
    ? "CI is set, so this run decides a merge"
    : "ROUTER_TEST_REQUIRE_DATABASE=1, set by bin/check"

  return [
    "DATABASE_URL is not set inside the test run, and a database was required",
    `(${reason}).`,
    "",
    "The live-Postgres suites would skip and this run would still go green,",
    "leaving unproven:",
    ...UNPROVEN.map((claim) => `  · ${claim}`),
    "",
    ...REMEDY.map((line) => `  ${line}`),
    "",
    RESOLUTION_NOTE,
  ].join("\n")
}

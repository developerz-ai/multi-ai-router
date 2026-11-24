import { SQL } from "bun"

/**
 * Prints the DATABASE_URL of shard N's own database, creating that database when it is missing.
 *
 *   printf '%s' "$DATABASE_URL" | bun bin/lib/ensure-test-database.ts <shard>
 *
 * `bin/test` runs the suite as shards in parallel, and the live-Postgres suites were written to own
 * the database they are pointed at: they truncate, they count rows, they contend on advisory locks
 * (which are scoped to a database). Two shards in one database would be two suites deleting each
 * other's rows, so every shard after the first gets a sibling database on the same server —
 * `router` → `router_shard2` — and the first keeps the one the caller named. Migrations are not run
 * here: the suites migrate the database they connect to, the same way they always have.
 *
 * THE URL ARRIVES ON STDIN, never as an argument: it carries a password, and an argument is
 * readable by every user on the machine for as long as the process lives (`ps`).
 *
 * A SHARD DATABASE IS ONLY EVER ONE THIS TOOL MADE. The suites truncate tables, so adopting a
 * database because its name matched would hand somebody's `router_shard2` to a run that empties it.
 * The database is created here and stamped with a comment saying so; one that already exists is
 * used only if it carries that stamp, and anything else is refused with the two ways out. A fresh
 * server — CI's service container — has no such database, so it is created and stamped there too.
 *
 * Uses Bun's built-in client so this tool needs no package from the workspace.
 */

/** The stamp `COMMENT ON DATABASE` carries. Changing it orphans every existing shard database. */
export const OWNERSHIP_MARK = "multi-ai-router test shard: created and emptied by bin/test"

/** PostgreSQL truncates an identifier to this many bytes, silently: two names could then collide. */
const MAX_IDENTIFIER_BYTES = 63

/** A PostgreSQL identifier, quoted: any name is legal inside quotes once the quotes are doubled. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

export type ShardName = { ok: true; name: string } | { ok: false; reason: string }

/** `router` → `router_shard2`. Any base name is allowed; only what PostgreSQL cannot hold is not. */
export function shardDatabaseName(base: string, shard: number): ShardName {
  if (base === "") return { ok: false, reason: "the DATABASE_URL names no database" }
  const name = `${base}_shard${shard}`
  if (name.includes("\0")) return { ok: false, reason: "a database name cannot contain NUL" }
  const bytes = new TextEncoder().encode(name).length
  if (bytes > MAX_IDENTIFIER_BYTES) {
    return {
      ok: false,
      reason: `${JSON.stringify(name)} is ${bytes} bytes; PostgreSQL would truncate it to ${MAX_IDENTIFIER_BYTES}`,
    }
  }
  return { ok: true, name }
}

function fail(message: string, code = 1): never {
  process.stderr.write(`ensure-test-database: ${message}\n`)
  process.exit(code)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const shard = Number(args[0])
  if (args.length !== 1 || !Number.isInteger(shard) || shard < 1) {
    process.stderr.write(
      "usage: printf '%s' \"$DATABASE_URL\" | ensure-test-database.ts <shard>\n" +
        "  (the URL is read from stdin: it carries a password and must not be an argument)\n",
    )
    process.exit(64)
  }

  const base = (await Bun.stdin.text()).trim()
  if (base === "") fail("no DATABASE_URL on stdin", 64)
  if (shard === 1) {
    process.stdout.write(base)
    return
  }

  let url: URL
  try {
    url = new URL(base)
  } catch {
    return fail("the DATABASE_URL on stdin is not a URL")
  }
  const named = shardDatabaseName(decodeURIComponent(url.pathname.slice(1)), shard)
  if (!named.ok) fail(named.reason)
  const { name } = named

  const sql = new SQL(base)
  try {
    const existing = await sql`
      SELECT shobj_description(oid, 'pg_database') AS mark FROM pg_database WHERE datname = ${name}`
    if (existing.length === 0) {
      await sql.unsafe(`CREATE DATABASE ${quoteIdentifier(name)}`)
      // The mark is a literal, not a parameter: COMMENT takes no bind values. It is a constant
      // of this file with no quote in it.
      await sql.unsafe(`COMMENT ON DATABASE ${quoteIdentifier(name)} IS '${OWNERSHIP_MARK}'`)
    } else if (existing[0]?.mark !== OWNERSHIP_MARK) {
      fail(
        `a database named ${JSON.stringify(name)} already exists and bin/test did not create it.\n` +
          "  The test suites TRUNCATE the database they run in, so it will not be used.\n" +
          `  If it is disposable:  DROP DATABASE ${quoteIdentifier(name)};  (bin/test recreates it)\n` +
          "  If it is not:         ROUTER_TEST_SHARDS=1 bin/test   runs the suite in one database",
      )
    }
  } finally {
    await sql.close()
  }

  url.pathname = `/${encodeURIComponent(name)}`
  process.stdout.write(url.toString())
}

if (import.meta.main) await main()

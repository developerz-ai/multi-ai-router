import { SQL } from "bun"

/**
 * Prints the DATABASE_URL of shard N's own database, creating that database when it is missing.
 *
 *   bun bin/lib/ensure-test-database.ts <DATABASE_URL> <shard>
 *
 * `bin/test` runs the suite as shards in parallel, and the live-Postgres suites were written to own
 * the database they are pointed at: they truncate, they count rows, they contend on advisory locks
 * (which are scoped to a database). Two shards in one database would be two suites deleting each
 * other's rows, so every shard after the first gets a sibling database on the same server —
 * `router` → `router_shard2` — and the first keeps the one the caller named. Migrations are not run
 * here: the suites migrate the database they connect to, the same way they always have.
 *
 * Uses Bun's built-in client so this tool needs no package from the workspace.
 */

const [base, shardArg] = process.argv.slice(2)
const shard = Number(shardArg)
if (base === undefined || !Number.isInteger(shard) || shard < 1) {
  process.stderr.write("usage: ensure-test-database.ts <DATABASE_URL> <shard>\n")
  process.exit(64)
}

if (shard === 1) {
  process.stdout.write(base)
  process.exit(0)
}

const url = new URL(base)
const name = `${decodeURIComponent(url.pathname.slice(1))}_shard${shard}`
// An identifier, interpolated into DDL below: refuse anything that would need quoting rules.
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
  process.stderr.write(`ensure-test-database: refusing database name ${JSON.stringify(name)}\n`)
  process.exit(1)
}

const sql = new SQL(base)
try {
  const existing = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`
  if (existing.length === 0) await sql.unsafe(`CREATE DATABASE "${name}"`)
} finally {
  await sql.close()
}

url.pathname = `/${name}`
process.stdout.write(url.toString())

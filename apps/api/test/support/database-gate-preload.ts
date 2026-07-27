/**
 * `bunfig.toml` preload: the authoritative half of the database gate.
 *
 * Runs once per `bun test` process, before the first test file is loaded, and
 * reads the same `process.env` the DB-gated suites will read — so unlike a shell
 * pre-check it cannot disagree with the run it is guarding. See
 * `database-gate.ts` for why that distinction is load-bearing.
 *
 * `process.exit` rather than `throw`: a throwing preload is re-reported once per
 * test file, so the one thing the reader needs would arrive buried under a
 * hundred identical stack traces. One message, exit 1, nothing green.
 */
import { databaseGateRefusal } from "./database-gate"

const refusal = databaseGateRefusal(process.env)

if (refusal !== null) {
  process.stderr.write(`\n\x1b[0;31m✘\x1b[0m  ${refusal}\n\n`)
  process.exit(1)
}

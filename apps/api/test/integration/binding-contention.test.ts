import { describe, expect, test } from "bun:test"
import { runBindingContention } from "../../bench/binding-contention"

const url = process.env.DATABASE_URL
describe.skipIf(!url)("offline actual binding contention fixture", () => {
  // The fixture drives 32 indexed/cache reads against a live Postgres, so its runtime
  // tracks the machine rather than the code under test. `bun test`'s default 5 s
  // per-test budget assumes an idle box; a loaded one (a full-suite run beside other
  // work) stretches it past that and fails a fixture that is in fact green.
  const DB_TEST_TIMEOUT_MS = 30_000
  test.each([0, 1])(
    "indexed/cache reads stay truthful after discarding %i warmup requests",
    async (warmup) => {
      if (!url) throw Error("fixture DATABASE_URL missing")
      const report = await runBindingContention(url, 1, 5, warmup)
      expect(report.results).toHaveLength(32)
      for (const row of report.results) {
        expect(row.queries).toBe(row.cache === "negative-hit" ? 0 : 1)
        expect(row.discardedWarmupQueries).toBe(row.cache === "negative-hit" ? 0 : warmup)
        expect(row.discardedWarmupRequests).toBe(warmup)
        expect(row.bindingWaitMs.count).toBe(1)
        expect(row.bodyReadWaitMs.count).toBe(1)
        expect(row.failures).toBe(0)
        expect(row.buffered).toBe(0)
      }
      expect(report.positive.invoked).toBe(2 * (1 + warmup))
      expect(report.positive.results).toHaveLength(2)
      for (const row of report.positive.results) {
        expect(row.queries).toBe(0)
        expect(row.failures).toBe(0)
      }
    },
    DB_TEST_TIMEOUT_MS,
  )
})

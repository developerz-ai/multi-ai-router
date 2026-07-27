import { describe, expect, test } from "bun:test"
import {
  type AccountReadiness,
  type ClaudeCliReadiness,
  checkReadiness,
  type ReadinessProbes,
} from "../../../src/services/health/readiness"

/**
 * Readiness as pure logic over injected probes: no server, no database, no clock.
 *
 * The gating rule is the one thing worth pinning here — only the database and the shutdown latch
 * withhold traffic, and everything else is reported. A change that started gating on accounts
 * would deadlock a fresh install, which is exactly the mistake this file exists to catch.
 */

function probes(overrides: Partial<ReadinessProbes> = {}): ReadinessProbes {
  return {
    database: () => Promise.resolve(true),
    accounts: () => Promise.resolve("ok" as AccountReadiness),
    claudeCli: () => Promise.resolve("platform_package" as ClaudeCliReadiness),
    shuttingDown: () => false,
    ...overrides,
  }
}

describe("checkReadiness", () => {
  test("is ready when the database answers", async () => {
    const report = await checkReadiness(probes())

    expect(report).toEqual({
      ready: true,
      shuttingDown: false,
      checks: { database: "ok", accounts: "ok", claudeCli: "platform_package" },
      reason: null,
    })
  })

  test("reports an empty and a blocked pool without withholding traffic", async () => {
    const empty = await checkReadiness(probes({ accounts: () => Promise.resolve("none") }))
    expect(empty.ready).toBe(true)
    expect(empty.reason).toBe("no accounts configured")

    const blocked = await checkReadiness(probes({ accounts: () => Promise.resolve("blocked") }))
    expect(blocked.ready).toBe(true)
    expect(blocked.reason).toBe("every account is unavailable")
  })

  test("a probe that throws is a failed probe, never a failed request", async () => {
    const report = await checkReadiness(
      probes({
        database: () => Promise.reject(new Error("connection refused")),
        accounts: () => Promise.reject(new Error("catalog cold")),
        claudeCli: () => Promise.reject(new Error("resolver blew up")),
      }),
    )

    expect(report.ready).toBe(false)
    expect(report.checks).toEqual({ database: "fail", accounts: "blocked", claudeCli: "missing" })
  })

  describe("while shutting down", () => {
    test("is not ready, and says which of the two kinds of not-ready it is", async () => {
      const report = await checkReadiness(probes({ shuttingDown: () => true }))

      expect(report.ready).toBe(false)
      expect(report.shuttingDown).toBe(true)
      expect(report.reason).toBe("shutting down — draining in-flight requests")
    })

    test("probes nothing: the answer is already no, and the pool is about to close", async () => {
      let probed = 0
      const count =
        <T>(value: T) =>
        (): Promise<T> => {
          probed += 1
          return Promise.resolve(value)
        }

      const report = await checkReadiness({
        database: count(true),
        accounts: count<AccountReadiness>("ok"),
        claudeCli: count<ClaudeCliReadiness>("platform_package"),
        shuttingDown: () => true,
      })

      expect(probed).toBe(0)
      // Nothing ran, so there is nothing honest to report — null rather than a stale `ok`.
      expect(report.checks).toBeNull()
    })

    test("withholds traffic even when every probe would have passed", async () => {
      const healthy = await checkReadiness(probes())
      expect(healthy.ready).toBe(true)

      const draining = await checkReadiness(probes({ shuttingDown: () => true }))
      expect(draining.ready).toBe(false)
    })
  })
})

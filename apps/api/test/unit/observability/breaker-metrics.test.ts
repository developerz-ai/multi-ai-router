import { describe, expect, test } from "bun:test"
import { createLogger, type Logger } from "../../../src/logging/logger"
import { createRuntimeMetrics } from "../../../src/observability"
import { createHealthStore } from "../../../src/services/dataplane"
import { account, catalog } from "../dataplane/fixtures"

/**
 * The breaker's own phase, and the half-open gate's admit/refuse count, seen from outside the
 * process.
 *
 * Before these, `router_accounts{status="cooling_down"}` was the only signal an operator had, and
 * it cannot answer either question a dashboard actually needs: whether a cooling account's reset
 * has already passed (a `429` a client keeps hitting is different from a probe that has not fired
 * yet), and whether the one-probe gate (`HealthStore.admitProbe`) is admitting or turning every
 * other request away while it waits.
 */

const SILENT: Logger = createLogger({ level: "error", write: () => {} })
const NOW = new Date("2026-07-27T12:00:00.000Z")

describe("router_breaker_state", () => {
  test("a healthy account reads closed=1 and every other phase zeroed", () => {
    const metrics = createRuntimeMetrics({
      catalog: catalog([account("acct-1")]),
      health: createHealthStore(),
      usage: () => ({
        stats: () => ({ depth: 0, dropped: 0, written: 0, writeFailures: 0, writeDiscarded: 0 }),
      }),
      logger: SILENT,
      now: () => NOW,
    })
    const body = metrics.expose()

    expect(body).toContain('router_breaker_state{account_id="acct-1",phase="closed"} 1')
    expect(body).toContain('router_breaker_state{account_id="acct-1",phase="open"} 0')
    expect(body).toContain('router_breaker_state{account_id="acct-1",phase="half-open"} 0')
    expect(body).toContain('router_breaker_state{account_id="acct-1",phase="blocked"} 0')
  })

  test("a tripped account reads open until its reset passes, then half-open", () => {
    const health = createHealthStore()
    health.recordFailure("acct-1", { kind: "rate-limited", retryAfterSeconds: 60 }, NOW)
    const metrics = createRuntimeMetrics({
      catalog: catalog([account("acct-1")]),
      health,
      usage: () => ({
        stats: () => ({ depth: 0, dropped: 0, written: 0, writeFailures: 0, writeDiscarded: 0 }),
      }),
      logger: SILENT,
      now: () => NOW,
    })

    expect(metrics.expose()).toContain('router_breaker_state{account_id="acct-1",phase="open"} 1')

    const past = new Date(NOW.getTime() + 61_000)
    const later = createRuntimeMetrics({
      catalog: catalog([account("acct-1")]),
      health,
      usage: () => ({
        stats: () => ({ depth: 0, dropped: 0, written: 0, writeFailures: 0, writeDiscarded: 0 }),
      }),
      logger: SILENT,
      now: () => past,
    })
    expect(later.expose()).toContain(
      'router_breaker_state{account_id="acct-1",phase="half-open"} 1',
    )
  })

  test("exhausted reads blocked, never open — the two must never be conflated", () => {
    const health = createHealthStore()
    health.recordFailure("acct-1", { kind: "credits-exhausted" }, NOW)
    const metrics = createRuntimeMetrics({
      catalog: catalog([account("acct-1")]),
      health,
      usage: () => ({
        stats: () => ({ depth: 0, dropped: 0, written: 0, writeFailures: 0, writeDiscarded: 0 }),
      }),
      logger: SILENT,
      now: () => NOW,
    })
    const body = metrics.expose()

    expect(body).toContain('router_breaker_state{account_id="acct-1",phase="blocked"} 1')
    expect(body).toContain('router_breaker_state{account_id="acct-1",phase="open"} 0')
  })

  test("a deleted account's phase is not left reporting stale — the gauge is cleared per scrape", () => {
    const health = createHealthStore()
    health.recordFailure("acct-1", { kind: "credits-exhausted" }, NOW)
    let accounts = [account("acct-1")]
    const metrics = createRuntimeMetrics({
      catalog: { accounts: () => accounts, pools: () => [] },
      health,
      usage: () => ({
        stats: () => ({ depth: 0, dropped: 0, written: 0, writeFailures: 0, writeDiscarded: 0 }),
      }),
      logger: SILENT,
      now: () => NOW,
    })
    expect(metrics.expose()).toContain('account_id="acct-1"')

    accounts = []
    expect(metrics.expose()).not.toContain('account_id="acct-1"')
  })
})

describe("router_breaker_probe_admissions_total", () => {
  test("reports nothing until a half-open account is actually probed", () => {
    const metrics = createRuntimeMetrics({
      catalog: catalog([account("acct-1")]),
      health: createHealthStore(),
      usage: () => ({
        stats: () => ({ depth: 0, dropped: 0, written: 0, writeFailures: 0, writeDiscarded: 0 }),
      }),
      logger: SILENT,
      now: () => NOW,
    })
    const body = metrics.expose()

    expect(body).toContain("# TYPE router_breaker_probe_admissions_total counter")
    expect(body).not.toContain("router_breaker_probe_admissions_total{")
  })

  test("counts one admission and every refusal behind it, as a delta per scrape", () => {
    const health = createHealthStore()
    health.recordFailure("acct-1", { kind: "rate-limited", retryAfterSeconds: 60 }, NOW)
    const past = new Date(NOW.getTime() + 61_000)
    const metrics = createRuntimeMetrics({
      catalog: catalog([account("acct-1")]),
      health,
      usage: () => ({
        stats: () => ({ depth: 0, dropped: 0, written: 0, writeFailures: 0, writeDiscarded: 0 }),
      }),
      logger: SILENT,
      now: () => past,
    })

    // One caller takes the hold; the next four find it already taken.
    health.admitProbe("acct-1", past)
    for (let i = 0; i < 4; i += 1) health.admitProbe("acct-1", past)

    const body = metrics.expose()
    expect(body).toContain('router_breaker_probe_admissions_total{result="admitted"} 1')
    expect(body).toContain('router_breaker_probe_admissions_total{result="refused"} 4')
  })
})

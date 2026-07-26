import { afterEach, describe, expect, test } from "bun:test"
import { createDatabase, type DatabaseHandle } from "@multi-ai-router/db"
import { createRuntime, type Runtime } from "../../src/composition"
import { parseEnv } from "../../src/config/env"
import { createLogger } from "../../src/logging/logger"
import type { RateLimitSignal } from "../../src/providers"
import { JITTER_FRACTION } from "../../src/services/routing"

/**
 * The production wiring, exercised through `createRuntime` itself.
 *
 * A test that hand-wires a store and asserts on it proves the store; it does not prove the router.
 * `ROUTING_FAILURE_THRESHOLD`, `ROUTING_BASE_BACKOFF_MS`, and `ROUTING_MAX_BACKOFF_MS` were parsed
 * at boot, documented in the environment reference, and read by absolutely nothing — precisely the
 * failure a unit test cannot see, because the unit was always fine.
 *
 * Nothing here connects: `postgres.js` dials lazily and no query is issued, so the composition root
 * assembles against an address that does not answer. The timers only start in `runtime.start()`,
 * which is deliberately never called.
 */

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
const NOW = new Date("2026-01-01T12:00:00.000Z")

const base: Record<string, string> = {
  // Unreachable on purpose. If anything below ever opens a connection, this test hangs and says so.
  DATABASE_URL: "postgres://nobody:nobody@127.0.0.1:1/none",
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "hunter2",
  ENCRYPTION_KEY,
}

let handle: DatabaseHandle | null = null

afterEach(async () => {
  await handle?.close()
  handle = null
})

function runtimeWith(overrides: Record<string, string>): Runtime {
  const env = parseEnv({ ...base, ...overrides })
  handle = createDatabase({ url: env.databaseUrl })
  return createRuntime({
    env,
    database: handle.db,
    sql: handle.sql,
    logger: createLogger({ level: "error", write: () => undefined }),
  })
}

describe("the breaker's environment reaches the breaker", () => {
  test("ROUTING_FAILURE_THRESHOLD decides when an account trips", () => {
    const { health } = runtimeWith({ ROUTING_FAILURE_THRESHOLD: "5" })
    const fail = () => health.recordFailure("a", { kind: "server-error", message: "500" }, NOW)

    for (let index = 0; index < 4; index += 1) fail()
    expect(health.stateOf("a").breaker.status).toBe("active")

    fail()
    expect(health.stateOf("a").breaker.status).toBe("cooling_down")
  })

  test("ROUTING_BASE_BACKOFF_MS decides how long, jittered within its own fraction", () => {
    const { health } = runtimeWith({
      ROUTING_FAILURE_THRESHOLD: "1",
      ROUTING_BASE_BACKOFF_MS: "4000",
    })
    health.recordFailure("a", { kind: "server-error", message: "500" }, NOW)

    const waited = (health.stateOf("a").breaker.cooldownUntil?.getTime() ?? 0) - NOW.getTime()
    expect(waited).toBeGreaterThanOrEqual(4_000)
    expect(waited).toBeLessThanOrEqual(4_000 * (1 + JITTER_FRACTION))
  })

  test("ROUTING_MAX_BACKOFF_MS caps the doubling", () => {
    const { health } = runtimeWith({
      ROUTING_FAILURE_THRESHOLD: "1",
      ROUTING_BASE_BACKOFF_MS: "4000",
      ROUTING_MAX_BACKOFF_MS: "5000",
    })
    for (let index = 0; index < 6; index += 1) {
      health.recordFailure("a", { kind: "server-error", message: "500" }, NOW)
    }

    const waited = (health.stateOf("a").breaker.cooldownUntil?.getTime() ?? 0) - NOW.getTime()
    expect(waited).toBeLessThanOrEqual(5_000 * (1 + JITTER_FRACTION))
  })

  test("accounts tripped in the same millisecond do not come back in the same one", () => {
    // The whole point of jitter, and it was never supplied: eight accounts knocked over together
    // used to return together and re-stampede whatever knocked them over.
    const { health } = runtimeWith({
      ROUTING_FAILURE_THRESHOLD: "1",
      ROUTING_BASE_BACKOFF_MS: "4000",
    })
    const resets = new Set<number>()
    for (let index = 0; index < 8; index += 1) {
      health.recordFailure(`acct-${index}`, { kind: "server-error", message: "500" }, NOW)
      resets.add(health.stateOf(`acct-${index}`).breaker.cooldownUntil?.getTime() ?? 0)
    }

    expect(resets.size).toBeGreaterThan(1)
  })
})

/**
 * Quota state has two halves and both hang off `createHealthStore`'s options. A hook that silently
 * goes unwired reads exactly like the bug this task fixed — readings observed, nothing persisted,
 * every gauge empty after a restart — and it typechecks, which is why it is asserted here rather
 * than only where the store is unit-tested.
 */
describe("an observed quota reading reaches the durable writer", () => {
  const reading = (utilization: number): RateLimitSignal => ({
    limited: false,
    resetSource: "provider-reported",
    windows: [],
    quotaWindows: [
      {
        window: "five_hour",
        utilization,
        utilizationSource: "threshold-triggered",
        resetsAt: new Date(NOW.getTime() + 3_600_000),
        resetSource: "provider-reported",
        lastCheckedAt: NOW,
      },
    ],
  })

  test("folding a named window queues it for the writer", () => {
    const { health, quotaWriter } = runtimeWith({})
    expect(quotaWriter.stats().pending).toBe(0)

    health.applyRateLimit("a", reading(0.9), NOW)

    // Queued, not written: nothing has touched the (deliberately unreachable) database, which is
    // the property that keeps this off the request path in the first place.
    expect(quotaWriter.stats()).toMatchObject({ pending: 1, written: 0 })
  })

  test("a reading with no named window queues nothing — every HTTP driver, every response", () => {
    const { health, quotaWriter } = runtimeWith({})
    health.applyRateLimit("a", { limited: true, resetSource: "unknown", windows: [] }, NOW)

    expect(quotaWriter.stats().pending).toBe(0)
  })

  test("Re-check now clears the Agent SDK's own buckets with the breaker marks", () => {
    // Without the wire, the operator dismisses a spent window and the next `rate_limit_event`
    // re-publishes it out of a bucket nobody cleared.
    const { health, sdkQuota } = runtimeWith({})
    sdkQuota.ingest("a", { status: "rejected", rateLimitType: "five_hour" }, NOW)
    expect(sdkQuota.snapshot("a")).not.toBeNull()

    health.reset("a")

    expect(sdkQuota.snapshot("a")).toBeNull()
  })
})

describe("the half-open gate is wired, per its own knob", () => {
  const recovered = new Date(NOW.getTime() + 60_000)

  const cooling = (overrides: Record<string, string> = {}): Runtime => {
    const runtime = runtimeWith({ ...overrides })
    runtime.health.recordFailure(
      "a",
      { kind: "rate-limited", resetsAt: new Date(NOW.getTime() + 60_000), message: "429" },
      NOW,
    )
    return runtime
  }

  test("one probe is admitted and the next is refused", () => {
    const { health } = cooling()

    expect(health.admitProbe("a", recovered).admitted).toBe(true)
    expect(health.admitProbe("a", recovered).admitted).toBe(false)
  })

  test("ROUTING_HALF_OPEN_HOLD_MS decides how long the hold lasts", () => {
    const { health } = cooling({ ROUTING_HALF_OPEN_HOLD_MS: "1234" })
    health.admitProbe("a", recovered)

    expect(health.stateOf("a").probeHeldUntil).toEqual(new Date(recovered.getTime() + 1_234))
  })
})

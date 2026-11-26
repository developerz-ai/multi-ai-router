import { expect, test } from "bun:test"
import { EnvValidationError, parseEnv } from "../../src/config/env"

const base = {
  DATABASE_URL: "postgres://router:router@localhost/router",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
}

// 05.4: every default is the constant the code shipped with, so an unset variable changes nothing.
test("SDK pacing and login deadlines default to the provider's constants", () => {
  expect(parseEnv(base).claudeSdkPacing).toEqual({
    streamIdleMs: 90_000,
    streamHeartbeatMs: 15_000,
    denyHoldMs: 60_000,
    loginUrlTimeoutMs: 30_000,
    loginExchangeTimeoutMs: 60_000,
    authStatusTimeoutMs: 15_000,
    teardownMs: 30_000,
    fastNativeSchemaTimeoutMs: 20_000,
    fastNativeSchemaMemoSize: 512,
  })
})

test("a heartbeat at or above the listener's idle clock refuses to boot", () => {
  expect(() =>
    parseEnv({
      ...base,
      SERVER_IDLE_TIMEOUT_SECONDS: "10",
      CLAUDE_SDK_STREAM_HEARTBEAT_SECONDS: "10",
    }),
  ).toThrow(/CLAUDE_SDK_STREAM_HEARTBEAT_SECONDS/)
  // `0` turns the listener's clock off; nothing for the heartbeat to beat.
  expect(
    parseEnv({
      ...base,
      SERVER_IDLE_TIMEOUT_SECONDS: "0",
      CLAUDE_SDK_STREAM_HEARTBEAT_SECONDS: "30",
    }).claudeSdkPacing.streamHeartbeatMs,
  ).toBe(30_000)
})

test("runtime limits read their variables and refuse zero where zero is no setting", () => {
  const env = parseEnv({
    ...base,
    KEY_CACHE_STALE_ON_ERROR_SECONDS: "0",
    KEY_VERIFY_MAX_PENDING: "8",
    TRUST_PROXY_HOPS: "2",
    MODEL_CATALOG_REFRESH_STARTUP_DELAY_SECONDS: "0",
  })
  expect(env.keyVerification).toEqual({
    negativeCacheMax: 1_024,
    maxPendingLoads: 8,
    staleOnErrorSeconds: 0,
  })
  expect(env.trustProxyHops).toBe(2)
  expect(env.schedulerLimits.modelCatalogRefreshStartupDelaySeconds).toBe(0)
  expect(env.routingLimits.maxReportedResetSeconds).toBe(691_200)
  for (const name of ["KEY_VERIFY_MAX_PENDING", "TRUST_PROXY_HOPS", "USAGE_RETRY_BUFFER_MAX"])
    expect(() => parseEnv({ ...base, [name]: "0" })).toThrow(EnvValidationError)
})

test("CLAUDE_SDK_QUEUE_WAIT_MS refuses a wait that defeats its own purpose", () => {
  expect(parseEnv(base).claudeSdkQueueWaitMs).toBe(60_000)
  expect(parseEnv({ ...base, CLAUDE_SDK_QUEUE_WAIT_MS: "240000" }).claudeSdkQueueWaitMs).toBe(
    240_000,
  )
  // Past the 300 s idle cut clients apply to a silent call, with headroom: the answer would arrive late.
  expect(() => parseEnv({ ...base, CLAUDE_SDK_QUEUE_WAIT_MS: "240001" })).toThrow(
    /CLAUDE_SDK_QUEUE_WAIT_MS.*at most 240000/s,
  )
  // Past the timer range it never fires (numeric-bounds.ts refuses it too).
  expect(() => parseEnv({ ...base, CLAUDE_SDK_QUEUE_WAIT_MS: "2147483648" })).toThrow(
    /CLAUDE_SDK_QUEUE_WAIT_MS/,
  )
  // The wait is spent before the attempt's own work (credential refresh, parsing), so it may use at
  // most half the attempt deadline: a value just under the deadline would lose the race anyway.
  expect(() =>
    parseEnv({ ...base, CLAUDE_SDK_QUEUE_WAIT_MS: "60000", UPSTREAM_TIMEOUT_MS: "60000" }),
  ).toThrow(
    /CLAUDE_SDK_QUEUE_WAIT_MS: 60000 must be at most 30000.*deadline of 60000 ms \(set by UPSTREAM_TIMEOUT_MS\)/s,
  )
  expect(() =>
    parseEnv({ ...base, CLAUDE_SDK_QUEUE_WAIT_MS: "59999", UPSTREAM_TIMEOUT_MS: "60000" }),
  ).toThrow(/CLAUDE_SDK_QUEUE_WAIT_MS/)
  expect(
    parseEnv({ ...base, CLAUDE_SDK_QUEUE_WAIT_MS: "30000", UPSTREAM_TIMEOUT_MS: "60000" })
      .claudeSdkQueueWaitMs,
  ).toBe(30_000)
  expect(() =>
    parseEnv({ ...base, CLAUDE_SDK_QUEUE_WAIT_MS: "30001", UPSTREAM_TIMEOUT_MS: "60000" }),
  ).toThrow(/at most 30000/)
})

// A streamed fast-mode attempt's total clock starts before the gate wait, so a short stream total
// bounds the wait exactly as a short attempt deadline does, and the refusal names the knob that set it.
test("CLAUDE_SDK_QUEUE_WAIT_MS is bounded by UPSTREAM_STREAM_TIMEOUT_MS too", () => {
  // The first-byte and idle clocks may not outlast the stream total, so a short one sets them too.
  const stream = (total: string) => ({
    ...base,
    UPSTREAM_STREAM_TIMEOUT_MS: total,
    UPSTREAM_FIRST_BYTE_TIMEOUT_MS: "1",
    UPSTREAM_IDLE_TIMEOUT_MS: "1",
  })
  expect(() => parseEnv({ ...stream("100"), CLAUDE_SDK_QUEUE_WAIT_MS: "300" })).toThrow(
    /300 must be at most 50.*deadline of 100 ms \(set by UPSTREAM_STREAM_TIMEOUT_MS\)/s,
  )
  expect(parseEnv({ ...stream("100"), CLAUDE_SDK_QUEUE_WAIT_MS: "50" }).claudeSdkQueueWaitMs).toBe(
    50,
  )
  // Unset: the default yields to it, and boot is never refused.
  expect(parseEnv(stream("100")).claudeSdkQueueWaitMs).toBe(50)
  expect(parseEnv(stream("1")).claudeSdkQueueWaitMs).toBe(0)
  // A stream total above the attempt deadline is not the binding one.
  expect(
    parseEnv({
      ...base,
      UPSTREAM_TIMEOUT_MS: "60000",
      UPSTREAM_STREAM_TIMEOUT_MS: "3600000",
    }).claudeSdkQueueWaitMs,
  ).toBe(30_000)
})

// An existing deployment that only lowered the attempt deadline never chose the new knob's default:
// refusing its boot would be a regression. Only a value the operator SET is refused.
test("an unset CLAUDE_SDK_QUEUE_WAIT_MS never refuses boot: the default yields to a short deadline", () => {
  expect(parseEnv({ ...base, UPSTREAM_TIMEOUT_MS: "120000" }).claudeSdkQueueWaitMs).toBe(60_000)
  expect(parseEnv({ ...base, UPSTREAM_TIMEOUT_MS: "60000" }).claudeSdkQueueWaitMs).toBe(30_000)
  expect(parseEnv({ ...base, UPSTREAM_TIMEOUT_MS: "20000" }).claudeSdkQueueWaitMs).toBe(10_000)
  // Half the attempt timeout rounded down, 60 s cap: it starts to shrink below a 120000 ms deadline.
  expect(parseEnv({ ...base, UPSTREAM_TIMEOUT_MS: "119999" }).claudeSdkQueueWaitMs).toBe(59_999)
  expect(parseEnv({ ...base, UPSTREAM_TIMEOUT_MS: "90000" }).claudeSdkQueueWaitMs).toBe(45_000)
  expect(parseEnv({ ...base, UPSTREAM_TIMEOUT_MS: "3" }).claudeSdkQueueWaitMs).toBe(1)
})

// A derived wait that would reach the deadline (a deadline of 2 ms or less) is not a wait at all: it
// is 0, which the gate reads as "admit now or refuse now", so the capacity verdict is returned
// before the deadline instead of racing it. An operator-set value is still refused, never derived.
test("an unset CLAUDE_SDK_QUEUE_WAIT_MS derives 0 when the deadline is too short to hold a wait", () => {
  expect(parseEnv({ ...base, UPSTREAM_TIMEOUT_MS: "1" }).claudeSdkQueueWaitMs).toBe(0)
  expect(parseEnv({ ...base, UPSTREAM_TIMEOUT_MS: "2" }).claudeSdkQueueWaitMs).toBe(0)
  expect(() =>
    parseEnv({ ...base, CLAUDE_SDK_QUEUE_WAIT_MS: "1", UPSTREAM_TIMEOUT_MS: "1" }),
  ).toThrow(/CLAUDE_SDK_QUEUE_WAIT_MS.*at most 0/s)
})

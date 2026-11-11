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

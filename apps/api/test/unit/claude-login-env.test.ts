import { describe, expect, test } from "bun:test"
import { parseEnv } from "../../src/config/env"

/** The login-lifetime and keepalive knobs: defaults, and the two settings refused at boot. */

const base = {
  DATABASE_URL: "postgres://router:router@localhost/router",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
}

describe("claude login env", () => {
  test("defaults: 28-day assumed login, 5-day warn, daily watch, 3-minute keepalive, hourly retry", () => {
    expect(parseEnv(base).claudeLogin).toEqual({
      assumedLifetimeDays: 28,
      renewalWarnDays: 5,
      watchIntervalMinutes: 1_440,
      keepaliveIntervalSeconds: 180,
      keepaliveRetryMinutes: 60,
    })
  })

  test("every knob is configurable", () => {
    const env = parseEnv({
      ...base,
      CLAUDE_LOGIN_ASSUMED_LIFETIME_DAYS: "30",
      CLAUDE_LOGIN_RENEWAL_WARN_DAYS: "7",
      LOGIN_LIFETIME_WATCH_INTERVAL_MINUTES: "720",
      CLAUDE_SDK_CREDENTIAL_KEEPALIVE_INTERVAL_SECONDS: "120",
      CLAUDE_SDK_CREDENTIAL_KEEPALIVE_RETRY_MINUTES: "30",
    })
    expect(env.claudeLogin).toEqual({
      assumedLifetimeDays: 30,
      renewalWarnDays: 7,
      watchIntervalMinutes: 720,
      keepaliveIntervalSeconds: 120,
      keepaliveRetryMinutes: 30,
    })
  })

  test("a keepalive cadence that can step over the CLI's five-minute lead is refused, naming why", () => {
    // 250 s × 1.2 jitter = 300 s: a tick gap that can straddle the whole window.
    expect(() =>
      parseEnv({ ...base, CLAUDE_SDK_CREDENTIAL_KEEPALIVE_INTERVAL_SECONDS: "250" }),
    ).toThrow(/CLAUDE_SDK_CREDENTIAL_KEEPALIVE_INTERVAL_SECONDS[\s\S]*must be below 250/)
  })

  test("the cadence bound follows the configured jitter", () => {
    expect(
      parseEnv({
        ...base,
        CLAUDE_SDK_CREDENTIAL_KEEPALIVE_INTERVAL_SECONDS: "250",
        SCHEDULER_JITTER_FRACTION: "0.1",
      }).claudeLogin.keepaliveIntervalSeconds,
    ).toBe(250)
  })

  test("under a wide jitter the default cadence shrinks to stay inside the lead", () => {
    expect(
      parseEnv({ ...base, SCHEDULER_JITTER_FRACTION: "1" }).claudeLogin.keepaliveIntervalSeconds,
    ).toBe(135)
  })

  test("a warn window as long as the login is refused", () => {
    expect(() =>
      parseEnv({
        ...base,
        CLAUDE_LOGIN_ASSUMED_LIFETIME_DAYS: "10",
        CLAUDE_LOGIN_RENEWAL_WARN_DAYS: "10",
      }),
    ).toThrow(/CLAUDE_LOGIN_RENEWAL_WARN_DAYS/)
  })
})

import { describe, expect, test } from "bun:test"
import {
  adminAuthConfigFromEnv,
  DEFAULT_ADMIN_AUTH_CONFIG,
  DEFAULT_ADMIN_AUTH_ENV,
  resolveAdminAuthConfig,
} from "../../../src/services/admin-auth/config"

/**
 * The env → seconds conversion is the only arithmetic between an operator's variable and a
 * session's lifetime, so it gets a test rather than a careful reading.
 */

describe("adminAuthConfigFromEnv", () => {
  test("converts each variable into the unit the service works in", () => {
    expect(
      adminAuthConfigFromEnv({
        adminSessionIdleMinutes: 30,
        adminSessionAbsoluteHours: 12,
        adminLoginMaxAttempts: 7,
        adminLoginAttemptWindowMinutes: 10,
        adminLoginLockoutMinutes: 20,
        adminSessionSlideFraction: 0.25,
      }),
    ).toEqual({
      idleTtlSeconds: 1_800,
      absoluteTtlSeconds: 43_200,
      maxFailedAttempts: 7,
      attemptWindowSeconds: 600,
      lockoutSeconds: 1_200,
      sessionSlideFraction: 0.25,
    })
  })

  test("the documented defaults are the ones the service falls back to", () => {
    expect(adminAuthConfigFromEnv(DEFAULT_ADMIN_AUTH_ENV)).toEqual(DEFAULT_ADMIN_AUTH_CONFIG)
    expect(DEFAULT_ADMIN_AUTH_CONFIG).toEqual({
      idleTtlSeconds: 8 * 3600,
      absoluteTtlSeconds: 24 * 3600,
      maxFailedAttempts: 5,
      attemptWindowSeconds: 15 * 60,
      lockoutSeconds: 15 * 60,
      sessionSlideFraction: 0.1,
    })
  })
})

describe("resolveAdminAuthConfig", () => {
  test("overrides only what it is given", () => {
    const config = resolveAdminAuthConfig({ idleTtlSeconds: 60 })

    expect(config.idleTtlSeconds).toBe(60)
    expect(config.lockoutSeconds).toBe(DEFAULT_ADMIN_AUTH_CONFIG.lockoutSeconds)
  })

  test("no overrides is the default set", () => {
    expect(resolveAdminAuthConfig()).toEqual(DEFAULT_ADMIN_AUTH_CONFIG)
  })
})

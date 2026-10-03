import { describe, expect, test } from "bun:test"
import { EnvValidationError, parseEnv } from "../../src/config/env"

const base = {
  DATABASE_URL: "postgres://router:router@localhost/router",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
}
const oidc = {
  ADMIN_OIDC_ISSUER_URL: "https://sso.test",
  ADMIN_OIDC_CLIENT_ID: "router",
  ADMIN_OIDC_REDIRECT_URI: "http://localhost:8080/api/admin/auth/oidc/callback",
  ADMIN_OIDC_ADMIN_EMAIL: "admin@test",
}

function rejects(variable: string, value: string, extra = {}) {
  try {
    parseEnv({ ...base, ...extra, [variable]: value })
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError)
    expect((error as EnvValidationError).variables).toContain(variable)
    return
  }
  throw new Error(`accepted invalid ${variable}`)
}

describe("numeric configuration boundaries", () => {
  for (const [variable, value] of [
    ["PORT", "65536"],
    ["UPSTREAM_TIMEOUT_MS", "2147483648"],
    ["KEY_CACHE_TTL_SECONDS", "9".repeat(400)],
    ["KEY_CACHE_MAX", "9007199254740992"],
    ["CATALOG_REFRESH_SECONDS", "2592000"],
    ["DB_POOL_CONNECT_TIMEOUT_SECONDS", "2147484"],
    ["RETENTION_OAUTH_STATE_MINUTES", "35792"],
    ["RETENTION_USAGE_DAYS", "24856"],
    ["ADMIN_SESSION_IDLE_MINUTES", "35791395"],
    ["UPSTREAM_ERROR_MAX_BYTES", "33554433"],
  ] as const) {
    test(`rejects overflow in ${variable}`, () => rejects(variable, value))
  }

  test("preserves boundary ports, timer maximum and documented zeros", () => {
    expect(parseEnv({ ...base, PORT: "65535" }).port).toBe(65535)
    expect(parseEnv({ ...base, PORT: "0" }).port).toBe(0)
    expect(
      parseEnv({ ...base, UPSTREAM_TIMEOUT_MS: "2147483647" }).failover.upstreamTimeoutMs,
    ).toBe(2147483647)
    const env = parseEnv({ ...base, SHUTDOWN_DRAIN_MS: "0", KEY_CACHE_NEGATIVE_TTL_SECONDS: "0" })
    expect(env.shutdownDrainMs).toBe(0)
    expect(env.dataPlane.keyCacheNegativeTtlSeconds).toBe(0)
  })

  test("accounts for catalog positive jitter", () => {
    const maximum = Math.floor(2147483647 / 1200)
    expect(
      parseEnv({ ...base, CATALOG_REFRESH_SECONDS: String(maximum) }).dataPlane
        .catalogRefreshSeconds,
    ).toBe(maximum)
    rejects("CATALOG_REFRESH_SECONDS", String(maximum + 1))
  })

  test("accounts for configured scheduler jitter when converting minutes", () => {
    for (const jitter of [0, 0.2, 1]) {
      const maximum = Math.floor(2147483647 / (60000 * (1 + jitter)))
      const extra = { SCHEDULER_JITTER_FRACTION: String(jitter) }
      expect(
        parseEnv({ ...base, ...extra, JANITOR_INTERVAL_MINUTES: String(maximum) })
          .janitorIntervalMinutes,
      ).toBe(maximum)
      rejects("JANITOR_INTERVAL_MINUTES", String(maximum + 1), extra)
    }
  })
})

describe("OIDC boot boundaries", () => {
  for (const variable of ["ADMIN_OIDC_ISSUER_URL", "ADMIN_OIDC_REDIRECT_URI"]) {
    for (const value of [
      "not-a-url",
      "/relative",
      "ftp://sso.test",
      "https://user:secret@sso.test",
      "https://sso.test/#fragment",
    ]) {
      test(`rejects unusable ${variable}: ${value.split(":")[0]}`, () =>
        rejects(variable, value, oidc))
    }
  }
  test("requires an explicit openid scope", () => {
    rejects("ADMIN_OIDC_SCOPES", "profile email", oidc)
    expect(parseEnv({ ...base, ...oidc, ADMIN_OIDC_SCOPES: "" }).adminOidc?.scopes).toEqual([
      "openid",
      "profile",
      "email",
    ])
  })
  test("issuer has no query while redirect may preserve one", () => {
    rejects("ADMIN_OIDC_ISSUER_URL", "https://sso.test/?query=value", oidc)
    expect(
      parseEnv({ ...base, ...oidc, ADMIN_OIDC_REDIRECT_URI: "http://localhost/callback?tenant=1" })
        .adminOidc?.redirectUri,
    ).toBe("http://localhost/callback?tenant=1")
  })
  test("keeps local login, localhost redirects, default scopes and explicit openid", () => {
    expect(parseEnv(base).adminOidc).toBeNull()
    expect(parseEnv({ ...base, ...oidc }).adminOidc?.scopes).toEqual(["openid", "profile", "email"])
    expect(parseEnv({ ...base, ...oidc, ADMIN_OIDC_SCOPES: " openid " }).adminOidc?.scopes).toEqual(
      ["openid"],
    )
  })
})

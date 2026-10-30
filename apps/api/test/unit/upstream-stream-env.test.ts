import { describe, expect, test } from "bun:test"
import { dispatchOptionsFromEnv } from "../../src/composition/dispatch-options"
import { EnvValidationError, parseEnv } from "../../src/config/env"

/**
 * `UPSTREAM_FIRST_BYTE_TIMEOUT_MS`, `UPSTREAM_IDLE_TIMEOUT_MS`, `UPSTREAM_STREAM_TIMEOUT_MS`: the
 * streamed HTTP attempt's three clocks (`services/dataplane/upstream-deadline.ts`). Parsed at boot,
 * refused when a clock could never fire inside the total, and carried to the dispatcher.
 */

const base: Record<string, string | undefined> = {
  DATABASE_URL: "postgres://router:router@postgres:5432/router",
  ADMIN_OIDC_ISSUER_URL: "https://sso.test",
  ADMIN_OIDC_CLIENT_ID: "multi-ai-router-test",
  ADMIN_OIDC_REDIRECT_URI: "https://router.test/api/admin/auth/oidc/callback",
  ADMIN_OIDC_ADMIN_EMAIL: "admin@test",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
}

function refusal(raw: Record<string, string>): string {
  try {
    parseEnv({ ...base, ...raw })
  } catch (error) {
    if (error instanceof EnvValidationError) return error.message
    throw error
  }
  throw new Error("expected a boot refusal")
}

describe("streamed upstream deadlines", () => {
  test("defaults: 5 min to first byte, 55 s idle, 1 h total", () => {
    expect(parseEnv(base).upstreamStream).toEqual({
      firstByteMs: 300_000,
      idleMs: 55_000,
      totalMs: 3_600_000,
    })
  })

  test("each is the operator's", () => {
    const env = parseEnv({
      ...base,
      UPSTREAM_FIRST_BYTE_TIMEOUT_MS: "60000",
      UPSTREAM_IDLE_TIMEOUT_MS: "30000",
      UPSTREAM_STREAM_TIMEOUT_MS: "7200000",
    })
    expect(env.upstreamStream).toEqual({ firstByteMs: 60_000, idleMs: 30_000, totalMs: 7_200_000 })
    expect(dispatchOptionsFromEnv(env).upstreamStream).toEqual(env.upstreamStream)
  })

  test.each([
    "UPSTREAM_FIRST_BYTE_TIMEOUT_MS",
    "UPSTREAM_IDLE_TIMEOUT_MS",
    "UPSTREAM_STREAM_TIMEOUT_MS",
  ])("%s refuses zero: an immediate deadline aborts every stream", (name) => {
    expect(refusal({ [name]: "0" })).toContain(name)
  })

  test.each(["UPSTREAM_FIRST_BYTE_TIMEOUT_MS", "UPSTREAM_IDLE_TIMEOUT_MS"])(
    "%s above the total is refused: it could never fire",
    (name) => {
      expect(refusal({ [name]: "7200000", UPSTREAM_STREAM_TIMEOUT_MS: "3600000" })).toContain(name)
    },
  )
})

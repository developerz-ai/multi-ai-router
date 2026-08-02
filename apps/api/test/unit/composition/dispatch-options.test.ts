import { describe, expect, test } from "bun:test"
import { dispatchOptionsFromEnv } from "../../../src/composition/dispatch-options"
import { parseEnv } from "../../../src/config/env"

/**
 * Parsed env -> dispatcher behavior, without booting a server.
 *
 * The integration harness builds its dispatcher with stubs and never crosses this line, so until
 * this file existed nothing asserted that `ROUTING_BOUND_ACCOUNT_COOLING_DOWN` — or any of its
 * siblings — actually reached selection. `ROUTING_FAILURE_THRESHOLD` was once parsed at boot and
 * read by nothing; this is the regression gate against the same shape here.
 */

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")

const base: Record<string, string | undefined> = {
  DATABASE_URL: "postgres://router:router@postgres:5432/router",
  ADMIN_OIDC_ISSUER_URL: "https://sso.test",
  ADMIN_OIDC_CLIENT_ID: "multi-ai-router-test",
  ADMIN_OIDC_REDIRECT_URI: "https://router.test/api/admin/auth/oidc/callback",
  ADMIN_OIDC_ADMIN_EMAIL: "admin@test",
  ENCRYPTION_KEY,
}

describe("dispatchOptionsFromEnv", () => {
  test("the default env dispatches with fail-mode bindings and the documented defaults", () => {
    const options = dispatchOptionsFromEnv(parseEnv(base))

    expect(options.selection?.boundAccountCoolingDown).toBe("fail")
    expect(options.failover?.maxAttempts).toBe(3)
    expect(options.upstreamTimeoutMs).toBe(600_000)
    expect(options.translation?.defaultMaxTokens).toBe(4_096)
    // Unset env still dispatches the documented default: the env layer owns it
    // (ROUTING_UNKNOWN_RESET_RETRY_AFTER_SECONDS ?? 30), so the value the router
    // runs with is visible in one place rather than falling through to a
    // routing-layer constant.
    expect(options.selection?.unknownResetRetryAfterSeconds).toBe(30)
  })

  test("ROUTING_BOUND_ACCOUNT_COOLING_DOWN=rebind reaches selection", () => {
    const options = dispatchOptionsFromEnv(
      parseEnv({ ...base, ROUTING_BOUND_ACCOUNT_COOLING_DOWN: "rebind" }),
    )

    expect(options.selection?.boundAccountCoolingDown).toBe("rebind")
  })

  test("the operator's failover numbers reach the dispatcher", () => {
    const options = dispatchOptionsFromEnv(
      parseEnv({
        ...base,
        ROUTING_MAX_ATTEMPTS: "5",
        UPSTREAM_TIMEOUT_MS: "120000",
        MAX_REQUEST_BODY_BYTES: "1048576",
      }),
    )

    expect(options.failover?.maxAttempts).toBe(5)
    expect(options.upstreamTimeoutMs).toBe(120_000)
    expect(options.body?.maxBytes).toBe(1_048_576)
  })
})

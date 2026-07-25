import { describe, expect, test } from "bun:test"
import { generateRouterKey } from "@multi-ai-router/core"
import { createLogger } from "../../src/logging/logger"
import { REDACTED, redact } from "../../src/logging/redact"

describe("redact", () => {
  test("scrubs credential-bearing field names whatever the value is", () => {
    const safe = redact({
      authorization: "Bearer sk-live-abcdef",
      "x-api-key": "mar_live_abc",
      cookie: "session=1",
      admin_password: "hunter2",
      refresh_token: "rt_123",
      code_verifier: "v_123",
      requestId: "req-1",
    })

    expect(safe).toEqual({
      authorization: REDACTED,
      "x-api-key": REDACTED,
      cookie: REDACTED,
      admin_password: REDACTED,
      refresh_token: REDACTED,
      code_verifier: REDACTED,
      requestId: "req-1",
    })
  })

  test("scrubs a router key that turns up under an innocent field name", () => {
    const key = generateRouterKey()
    const safe = redact({ note: `client sent ${key} twice` })

    expect(safe.note).toBe(`client sent ${REDACTED} twice`)
    expect(JSON.stringify(safe)).not.toContain(key)
  })

  test("scrubs nested objects and arrays", () => {
    const safe = redact({ upstream: { headers: { authorization: "Bearer abc" } }, tries: [1, 2] })

    expect(safe).toEqual({ upstream: { headers: { authorization: REDACTED } }, tries: [1, 2] })
  })
})

describe("redact — the OAuth connect and refresh flows", () => {
  /**
   * `services/accounts/connect/oauth.ts` and `./refresh/` are the two places a `code`, a
   * `code_verifier`, a `state`, or a refresh token ever exist in this process — and per those
   * modules' own doc blocks, none of the four is meant to reach a log line or an error body in the
   * first place. This pins the redactor as the backstop: if a future call site ever logged one of
   * these shapes by accident, nothing here would survive.
   */

  test("a callback query — code, state, and a stray error — is fully scrubbed", () => {
    const safe = redact({
      code: "ac_live_notarealcode",
      state: "s-9f2c1c8b",
      error: "access_denied",
      accountId: "11111111-2222-3333-4444-555555555555",
    })

    expect(safe).toEqual({
      code: REDACTED,
      state: REDACTED,
      error: "access_denied",
      accountId: "11111111-2222-3333-4444-555555555555",
    })
  })

  test("the PKCE verifier is scrubbed under either spelling", () => {
    const safe = redact({
      code_verifier: "raw-verifier-value",
      codeVerifier: "raw-verifier-value",
      codeChallenge: "not-secret-derived-value",
    })

    expect(safe.code_verifier).toBe(REDACTED)
    expect(safe.codeVerifier).toBe(REDACTED)
    // The challenge is a one-way hash of the verifier, not the secret itself.
    expect(safe.codeChallenge).toBe("not-secret-derived-value")
  })

  test("a token-endpoint response body is scrubbed field by field", () => {
    const safe = redact({
      access_token: "at_live_abc123",
      refresh_token: "rt_live_def456",
      accessToken: "at_live_abc123",
      refreshToken: "rt_live_def456",
      id_token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.sig",
      expires_in: 3600,
    })

    expect(safe).toEqual({
      access_token: REDACTED,
      refresh_token: REDACTED,
      accessToken: REDACTED,
      refreshToken: REDACTED,
      id_token: REDACTED,
      expires_in: 3600,
    })
  })

  test("a bearer-shaped value inside an error message is scrubbed even under an innocent field name", () => {
    // `services/accounts/refresh/refresher.ts`'s `describe(error)` runs exactly this value-level
    // scrub over a caught error's `.message` before it ever reaches a log line.
    const safe = redact({
      component: "account-refresher",
      accountId: "acct-1",
      error: "token endpoint rejected the request: Authorization: Bearer at_live_abcdef123456",
    })

    expect(safe.error).toBe(`token endpoint rejected the request: Authorization: ${REDACTED}`)
  })

  test("an authorized-code exchange payload, logged whole, leaves no credential material", () => {
    const safe = redact({
      row: { id: "acct-1", provider: "openai-oauth" },
      code: "ac_live_notarealcode",
      redirectUri: "http://localhost:1455/auth/callback",
      codeVerifier: "raw-verifier-value",
      capture: "paste",
    })

    const serialized = JSON.stringify(safe)
    expect(serialized).not.toContain("ac_live_notarealcode")
    expect(serialized).not.toContain("raw-verifier-value")
    expect(safe.capture).toBe("paste")
    expect(safe.redirectUri).toBe("http://localhost:1455/auth/callback")
  })
})

describe("createLogger", () => {
  test("emits one redacted JSON line per event, with the bound fields", () => {
    const lines: string[] = []
    const log = createLogger({ level: "info", write: (line) => lines.push(line) })

    log.child({ requestId: "req-1" }).warn("upstream failed", { authorization: "Bearer abc" })

    expect(lines).toHaveLength(1)
    const entry: unknown = JSON.parse(lines[0] ?? "{}")
    expect(entry).toMatchObject({
      level: "warn",
      msg: "upstream failed",
      requestId: "req-1",
      authorization: REDACTED,
    })
  })

  test("drops everything below the configured level", () => {
    const lines: string[] = []
    const log = createLogger({ level: "warn", write: (line) => lines.push(line) })

    log.debug("noisy")
    log.info("routine")
    log.error("real")

    expect(lines).toHaveLength(1)
  })
})

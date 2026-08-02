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

describe("redact — self-identifying credential shapes", () => {
  /**
   * The field-name list only helps when the caller named the field honestly. These are the shapes
   * that must not survive a log line whatever they are called: an upstream is free to quote a key
   * back at us inside an error message, and `services/translate/shared/errors.ts` puts exactly that
   * message on a client-facing surface after running it through `redactValue`.
   */

  test("a JWT is scrubbed under an innocent field name", () => {
    // ChatGPT/Codex access tokens are JWTs — the shape, not the field name, is what catches them.
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEiLCJleHAiOjE3MDAwMDAwMDB9.c2lnbmF0dXJl"
    const safe = redact({ note: `upstream returned ${jwt} again` })

    expect(safe.note).toBe(`upstream returned ${REDACTED} again`)
  })

  test("a connection string loses its credentials and keeps its host", () => {
    const safe = redact({
      error: "connect failed: postgres://router:s3cr3t-pw@db.internal:5432/app",
    })

    expect(safe.error).toBe(`connect failed: postgres://${REDACTED}@db.internal:5432/app`)
  })

  test("a Google API key is scrubbed", () => {
    const googleKey = `AIzaSy${"0".repeat(33)}`
    const safe = redact({ detail: `rejected ${googleKey}` })

    expect(safe.detail).toBe(`rejected ${REDACTED}`)
  })

  test("GitHub tokens are scrubbed, classic and fine-grained", () => {
    const safe = redact({
      classic: `ghp_${"a".repeat(36)}`,
      fineGrained: `github_pat_${"B".repeat(30)}`,
    })

    expect(safe).toEqual({ classic: REDACTED, fineGrained: REDACTED })
  })

  test("an xAI key is scrubbed", () => {
    const safe = redact({ detail: `xai-${"b".repeat(40)}` })

    expect(safe.detail).toBe(REDACTED)
  })

  test("a Groq key is scrubbed", () => {
    const safe = redact({ detail: `gsk_${"c".repeat(32)}` })

    expect(safe.detail).toBe(REDACTED)
  })

  test("a Cerebras key is scrubbed, and a DeepSeek one by the shared sk- shape", () => {
    const safe = redact({
      cerebras: `csk-${"d".repeat(40)}`,
      deepseek: `sk-${"e".repeat(32)}`,
    })

    expect(safe).toEqual({ cerebras: REDACTED, deepseek: REDACTED })
  })

  test("a credential in a query string is scrubbed, and the endpoint survives", () => {
    const safe = redact({
      keyed: `https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSy${"0".repeat(33)}&alt=sse`,
      hyphenated: "https://example.test/v1/chat?api-key=abcdef123456",
      underscored: "https://example.test/v1/chat?api_key=abcdef123456",
    })

    expect(safe.keyed).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${REDACTED}&alt=sse`,
    )
    expect(safe.hyphenated).toBe(`https://example.test/v1/chat?api-key=${REDACTED}`)
    expect(safe.underscored).toBe(`https://example.test/v1/chat?api_key=${REDACTED}`)
  })

  test("a whole OAuth callback URL logged as one string keeps nothing redeemable", () => {
    // The field-name list cannot help here: the `code` and the `state` are inside a value called
    // `url`. They are one-shot, but a log line outlives the ten-minute window that binds them.
    const safe = redact({
      url: "https://router.test/admin/accounts/oauth/callback?code=ac_live_x1&state=s-9f2c&error=access_denied",
    })

    expect(safe.url).toBe(
      `https://router.test/admin/accounts/oauth/callback?code=${REDACTED}&state=${REDACTED}&error=access_denied`,
    )
  })

  test("a refresh token in a query string is scrubbed despite the prefix", () => {
    const safe = redact({ url: "https://example.test/oauth/token?refresh_token=rt_live_abc&x=1" })

    expect(safe.url).toBe(`https://example.test/oauth/token?refresh_token=${REDACTED}&x=1`)
  })

  test("vendor credential headers are scrubbed by name", () => {
    const safe = redact({
      "x-goog-api-key": "not-a-real-key",
      "x-goog-user-project": "some-gcp-project",
      // `anthropic-auth-token`, `access_token`, `refresh_token`, and `id_token` all carry the
      // `token` marker — this pins that the marker really is what covers them.
      "anthropic-auth-token": "not-a-real-token",
      "x-request-id": "req-1",
    })

    expect(safe).toEqual({
      "x-goog-api-key": REDACTED,
      "x-goog-user-project": REDACTED,
      "anthropic-auth-token": REDACTED,
      "x-request-id": "req-1",
    })
  })

  test("a Basic credential is scrubbed, not just a Bearer one", () => {
    const safe = redact({ detail: "upstream sent Authorization: Basic YWRtaW46aHVudGVyMg==" })

    expect(safe.detail).toBe(`upstream sent Authorization: ${REDACTED}`)
  })

  test("a URL with no credentials in it is left alone", () => {
    const safe = redact({
      base: "https://api.example.test:8443/v1/messages",
      query: "https://api.example.test/v1/models?limit=20&after=acct-1",
    })

    expect(safe).toEqual({
      base: "https://api.example.test:8443/v1/messages",
      query: "https://api.example.test/v1/models?limit=20&after=acct-1",
    })
  })

  test("a failed-attempt record nested three deep is still scrubbed, name and shape", () => {
    const safe = redact({
      attempt: {
        upstream: {
          headers: { "x-goog-api-key": "not-a-real-key", "x-request-id": "up-1" },
          url: `https://example.test/v1?api-key=AIzaSy${"0".repeat(33)}`,
          note: `retried with ghp_${"a".repeat(36)}`,
        },
      },
    })

    expect(safe).toEqual({
      attempt: {
        upstream: {
          headers: { "x-goog-api-key": REDACTED, "x-request-id": "up-1" },
          url: `https://example.test/v1?api-key=${REDACTED}`,
          note: `retried with ${REDACTED}`,
        },
      },
    })
  })
})

describe("redact — the spellings of one field name", () => {
  /**
   * A field name is matched with `-` and `_` stripped, so a call site cannot open a hole by
   * choosing the separator the list happens not to carry. `Env.databaseUrl` and
   * `Env.encryptionKey` are camelCase, and one `log.info("boot", { env })` is all it takes.
   */

  test("an API key is scrubbed hyphenated, underscored, and camelCased", () => {
    const safe = redact({
      "api-key": "not-a-real-key",
      api_key: "not-a-real-key",
      apiKey: "not-a-real-key",
      "x-api-key": "not-a-real-key",
    })

    expect(safe).toEqual({
      "api-key": REDACTED,
      api_key: REDACTED,
      apiKey: REDACTED,
      "x-api-key": REDACTED,
    })
  })

  test("the encryption key is scrubbed under either spelling", () => {
    const safe = redact({ encryption_key: "base64-master", encryptionKey: "base64-master" })

    expect(safe).toEqual({ encryption_key: REDACTED, encryptionKey: REDACTED })
  })

  test("the whole validated env, logged as one object, leaves nothing redeemable", () => {
    const safe = redact({
      env: {
        encryptionKey: "bWFzdGVyLWtleQ==",
        databaseUrl: "postgres://router:s3cr3t-pw@db.internal:5432/router",
        adminUsername: "ops",
        adminCredential: "hunter2",
        port: 8080,
      },
    })

    const serialized = JSON.stringify(safe)
    expect(serialized).not.toContain("bWFzdGVyLWtleQ==")
    expect(serialized).not.toContain("s3cr3t-pw")
    expect(serialized).not.toContain("hunter2")
    expect(safe.env).toEqual({
      encryptionKey: REDACTED,
      databaseUrl: `postgres://${REDACTED}@db.internal:5432/router`,
      adminUsername: "ops",
      adminCredential: REDACTED,
      port: 8080,
    })
  })

  test("a key's id and name survive — they are how an operator reads the line", () => {
    // `middleware/routerKeyAuth.ts` binds both onto every request logger. A bare `key` marker
    // would scrub them and take the only handle on *which* key a line belongs to with it.
    const safe = redact({ keyId: "key-1", keyName: "laptop", publicKey: "not-a-secret" })

    expect(safe).toEqual({ keyId: "key-1", keyName: "laptop", publicKey: "not-a-secret" })
  })
})

describe("redact — values that hide their payload from Object.entries", () => {
  test("an Error keeps its name and message, scrubbed", () => {
    const safe = redact({ cause: new TypeError("upstream rejected Bearer at_live_abcdef123456") })

    expect(safe.cause).toBe(`TypeError: upstream rejected ${REDACTED}`)
  })

  test("a credential-bearing cause survives the chain-join scrubbed — never verbatim", () => {
    // The failure case this flattening exists for: the wrapper's message is all statement, and
    // the complaint one `cause` down quotes DATABASE_URL back. Both halves must hold at once —
    // the cause reaches the line, the credential does not.
    const safe = redact({
      error: new Error("Failed query: select 1", {
        cause: new Error("connect failed: postgres://router:s3cret-pw@db.internal:5432/router"),
      }),
    })

    const line = String(safe.error)
    expect(line).toStartWith("connect failed:")
    expect(line).toContain("Failed query")
    expect(line).toContain("db.internal")
    expect(line).not.toContain("s3cret-pw")
  })

  test("an Error field is no longer wrapper-only: the cause chain reaches the line, bounded", () => {
    const safe = redact({
      error: new Error(`Failed query: insert ${"$1, ".repeat(500)}`, {
        cause: new Error("bind refused"),
      }),
    })

    const line = String(safe.error)
    // Innermost first: truncation eats the wrapper's statement text, never the root complaint.
    expect(line).toStartWith("bind refused ← Failed query:")
    expect(line.length).toBeLessThanOrEqual(500)
    expect(line).toEndWith("…")
  })

  test("a Map is scrubbed by key name and by value, not flattened to an empty object", () => {
    const safe = redact({
      headers: new Map([
        ["authorization", "Bearer at_live_abcdef123456"],
        ["x-request-id", "up-1"],
        ["x-note", `retried with ghp_${"a".repeat(36)}`],
      ]),
    })

    expect(safe.headers).toEqual({
      authorization: REDACTED,
      "x-request-id": "up-1",
      "x-note": `retried with ${REDACTED}`,
    })
  })

  test("a Set keeps its members, scrubbed", () => {
    const safe = redact({ seen: new Set([`sk-${"e".repeat(32)}`, "acct-1"]) })

    expect(safe.seen).toEqual([REDACTED, "acct-1"])
  })

  test("a value nested past the depth ceiling still fails closed", () => {
    // The walk stops at four levels rather than trusting a shape it has not seen. Unwrapping
    // errors and maps must not become a way around that.
    const safe = redact({ a: { b: { c: { d: { authorization: "Bearer at_live_abcdef" } } } } })

    expect(safe).toEqual({ a: { b: { c: { d: REDACTED } } } })
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

  test("scrubs the message too, not just the fields beside it", () => {
    // No call site interpolates a message today, which is exactly why this is easy to lose: the
    // guarantee `docs/idea/08-observability.md` makes covers the whole line, and `msg` is half of
    // it.
    const lines: string[] = []
    const log = createLogger({ level: "info", write: (line) => lines.push(line) })

    log.info("upstream rejected Bearer at_live_abcdef123456", { accountId: "acct-1" })

    const entry: unknown = JSON.parse(lines[0] ?? "{}")
    expect(entry).toMatchObject({
      msg: `upstream rejected ${REDACTED}`,
      accountId: "acct-1",
    })
    expect(lines[0]).not.toContain("at_live_abcdef123456")
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

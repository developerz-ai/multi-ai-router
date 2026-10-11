import { describe, expect, test } from "bun:test"
import { UpstreamAuthError } from "@multi-ai-router/core"
import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_CODEX_BASE_URL,
  chatGptAccountId,
  httpDriver,
  OPENAI_AUTH_CLAIM,
  OPENAI_CODEX_ORIGINATOR,
  OPENAI_OAUTH_AUTHORIZE_URL,
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_ISSUER,
  OPENAI_OAUTH_LOOPBACK_REDIRECT_URI,
  OPENAI_OAUTH_REFRESH_SCOPE,
  OPENAI_OAUTH_SCOPE,
  OPENAI_OAUTH_TOKEN_URL,
  openAiOAuthAuthorizeUrl,
  openAiOAuthCodeExchange,
  openAiOAuthDriver,
  openAiOAuthRefresh,
  type ProviderCredential,
  parseCodexQuotaHeaders,
  readOpenAiOAuthTokens,
} from "../../../src/providers"
import { account, response } from "./fixtures"

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.not-a-real-signature`
}
const codex = httpDriver("openai-oauth")
if (codex === null) throw new Error("no HTTP driver registered for openai-oauth")
describe("pinned constants", () => {
  test("the issuer, client id, and endpoints match the first-party client", () => {
    expect(OPENAI_OAUTH_ISSUER).toBe("https://auth.openai.com")
    expect(OPENAI_OAUTH_CLIENT_ID).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
    expect(OPENAI_OAUTH_AUTHORIZE_URL).toBe("https://auth.openai.com/oauth/authorize")
    expect(OPENAI_OAUTH_TOKEN_URL).toBe("https://auth.openai.com/oauth/token")
  })
  test("the connect scope earns a refresh token; the refresh scope does not re-ask for one", () => {
    expect(OPENAI_OAUTH_SCOPE).toBe("openid profile email offline_access")
    expect(OPENAI_OAUTH_REFRESH_SCOPE).toBe("openid profile email")
  })
  test("the loopback redirect is the paste-mode fallback address", () => {
    expect(OPENAI_OAUTH_LOOPBACK_REDIRECT_URI).toBe("http://localhost:1455/auth/callback")
  })
  test("the Codex surface and its required header", () => {
    expect(CHATGPT_CODEX_BASE_URL).toBe("https://chatgpt.com/backend-api/codex")
    expect(OPENAI_AUTH_CLAIM).toBe("https://api.openai.com/auth")
    expect(CHATGPT_ACCOUNT_ID_HEADER).toBe("chatgpt-account-id")
  })
  test("the driver resolves to the pinned Codex base URL", () => {
    expect(codex.resolveBaseUrl(account({ provider: "openai-oauth" })).toString()).toBe(
      "https://chatgpt.com/backend-api/codex",
    )
  })
})
describe("the authorization URL", () => {
  test("carries every parameter the issuer requires, S256 only", () => {
    const url = openAiOAuthAuthorizeUrl({
      redirectUri: "https://router.example/admin/accounts/oauth/callback",
      state: "state-123",
      codeChallenge: "challenge-abc",
    })
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize")
    const params = url.searchParams
    expect(params.get("response_type")).toBe("code")
    expect(params.get("client_id")).toBe(OPENAI_OAUTH_CLIENT_ID)
    expect(params.get("redirect_uri")).toBe("https://router.example/admin/accounts/oauth/callback")
    expect(params.get("scope")).toBe(OPENAI_OAUTH_SCOPE)
    expect(params.get("code_challenge")).toBe("challenge-abc")
    expect(params.get("code_challenge_method")).toBe("S256")
    expect(params.get("id_token_add_organizations")).toBe("true")
    expect(params.get("state")).toBe("state-123")
  })
  test("asks for the Codex consent page, as the Codex CLI itself does", () => {
    const params = openAiOAuthAuthorizeUrl({
      redirectUri: OPENAI_OAUTH_LOOPBACK_REDIRECT_URI,
      state: "s",
      codeChallenge: "c",
    }).searchParams
    expect(params.get("codex_cli_simplified_flow")).toBe("true")
    expect(params.get("originator")).toBe(OPENAI_CODEX_ORIGINATOR)
    expect(OPENAI_CODEX_ORIGINATOR).toBe("codex_cli_rs")
  })
})
describe("the two token requests do not agree, on purpose", () => {
  test("the code exchange is form-encoded", () => {
    const built = openAiOAuthCodeExchange({
      code: "the-code",
      redirectUri: "http://localhost:1455/auth/callback",
      codeVerifier: "the-verifier",
    })
    expect(built.url).toBe(OPENAI_OAUTH_TOKEN_URL)
    expect(built.method).toBe("POST")
    expect(built.headers["content-type"]).toBe("application/x-www-form-urlencoded")
    const body = new URLSearchParams(built.body)
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("code")).toBe("the-code")
    expect(body.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
    expect(body.get("client_id")).toBe(OPENAI_OAUTH_CLIENT_ID)
    expect(body.get("code_verifier")).toBe("the-verifier")
  })
  test("the refresh is JSON, and carries no redirect_uri or verifier", () => {
    const built = openAiOAuthRefresh({ refreshToken: "the-refresh-token" })
    expect(built.url).toBe(OPENAI_OAUTH_TOKEN_URL)
    expect(built.headers["content-type"]).toBe("application/json")
    const body: unknown = JSON.parse(built.body)
    expect(body).toEqual({
      client_id: OPENAI_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "the-refresh-token",
      scope: OPENAI_OAUTH_REFRESH_SCOPE,
    })
    expect(built.body).not.toContain("redirect_uri")
    expect(built.body).not.toContain("code_verifier")
  })
  test("sending one shape in the other's encoding is exactly the trap the driver avoids", () => {
    const exchange = openAiOAuthCodeExchange({
      code: "c",
      redirectUri: "http://localhost:1455/auth/callback",
      codeVerifier: "v",
    })
    const refresh = openAiOAuthRefresh({ refreshToken: "r" })
    expect(exchange.headers["content-type"]).not.toBe(refresh.headers["content-type"])
  })
})
describe("reading the token response", () => {
  test("a well-formed response yields every field, deriving the ChatGPT account id", () => {
    const idToken = jwt({ [OPENAI_AUTH_CLAIM]: { chatgpt_account_id: "acct_from_id_token" } })
    const tokens = readOpenAiOAuthTokens({
      access_token: "access-1",
      refresh_token: "refresh-1",
      id_token: idToken,
      expires_in: 3600,
    })
    expect(tokens).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      idToken,
      expiresInSeconds: 3600,
      chatGptAccountId: "acct_from_id_token",
      providerAccountId: "acct_from_id_token",
    })
  })
  test("a refresh response with no refresh_token or id_token still reads", () => {
    const tokens = readOpenAiOAuthTokens({ access_token: "access-1", expires_in: 60 })
    expect(tokens).toEqual({
      accessToken: "access-1",
      refreshToken: null,
      idToken: null,
      expiresInSeconds: 60,
      chatGptAccountId: null,
    })
  })
  test("a reshaped payload yields null, never a half-populated token set", () => {
    expect(readOpenAiOAuthTokens({ access_token: "" })).toBeNull()
    expect(readOpenAiOAuthTokens({})).toBeNull()
    expect(readOpenAiOAuthTokens(null)).toBeNull()
    expect(readOpenAiOAuthTokens("access-1")).toBeNull()
  })
})
describe("deriving the ChatGPT account id", () => {
  test("prefers the id_token's claim over the access_token's", () => {
    const idToken = jwt({ [OPENAI_AUTH_CLAIM]: { chatgpt_account_id: "from-id-token" } })
    const accessToken = jwt({ [OPENAI_AUTH_CLAIM]: { chatgpt_account_id: "from-access-token" } })
    expect(chatGptAccountId({ idToken, accessToken })).toBe("from-id-token")
  })
  test("falls back to the access_token when there is no id_token", () => {
    const accessToken = jwt({ [OPENAI_AUTH_CLAIM]: { chatgpt_account_id: "from-access-token" } })
    expect(chatGptAccountId({ accessToken })).toBe("from-access-token")
  })
  test("a token with no claim, or no token at all, derives nothing", () => {
    expect(chatGptAccountId({ idToken: jwt({ some: "other-claim" }) })).toBeNull()
    expect(chatGptAccountId({ accessToken: "not-a-jwt-at-all" })).toBeNull()
    expect(chatGptAccountId({})).toBeNull()
    expect(chatGptAccountId({ idToken: null, accessToken: undefined })).toBeNull()
  })
})
describe("headers, derived from the stored token", () => {
  const OAUTH_WITH_CLAIM: ProviderCredential = {
    kind: "oauth",
    accessToken: jwt({ [OPENAI_AUTH_CLAIM]: { chatgpt_account_id: "acct_777" } }),
  }
  test("sends the derived chatgpt-account-id header alongside the bearer token", () => {
    const headers = openAiOAuthDriver.buildHeaders(
      account({ provider: "openai-oauth" }),
      OAUTH_WITH_CLAIM,
    )
    expect(headers.get("chatgpt-account-id")).toBe("acct_777")
    expect(headers.get("authorization")).toBe(`Bearer ${OAUTH_WITH_CLAIM.accessToken}`)
    expect(headers.get("originator")).toBe(OPENAI_CODEX_ORIGINATOR)
  })
  test("a top-level chatgpt_account_id claim is read when the namespaced one is absent", () => {
    expect(chatGptAccountId({ accessToken: jwt({ chatgpt_account_id: "acct_flat" }) })).toBe(
      "acct_flat",
    )
    const both = jwt({
      chatgpt_account_id: "acct_flat",
      [OPENAI_AUTH_CLAIM]: { chatgpt_account_id: "acct_nested" },
    })
    expect(chatGptAccountId({ accessToken: both })).toBe("acct_nested")
  })
  test("refuses to send a request with no derivable account id, naming the account", () => {
    const noClaimToken: ProviderCredential = { kind: "oauth", accessToken: "opaque-no-claim" }
    const subject = account({ id: "acct-under-test", provider: "openai-oauth" })
    expect(() => openAiOAuthDriver.buildHeaders(subject, noClaimToken)).toThrow(UpstreamAuthError)
    try {
      openAiOAuthDriver.buildHeaders(subject, noClaimToken)
      throw new Error("expected buildHeaders to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamAuthError)
      expect((error as Error).message).toContain("acct-under-test")
      expect((error as Error).message).not.toContain("opaque-no-claim")
    }
  })
})
describe("Codex failure wording", () => {
  test("usage_limit_reached is a cooldown, not a dead account", () => {
    const result = codex.classifyFailure(
      response(429, { body: { detail: { code: "usage_limit_reached", message: "5h limit hit" } } }),
    )
    expect(result?.kind).toBe("rate-limited")
    expect(result?.retryable).toBe(true)
    expect(result?.signal).toBe("openai-oauth:usage_limit_reached")
  })
  test("rate_limit_exceeded reads the same way, by type instead of code", () => {
    const result = codex.classifyFailure(
      response(429, { body: { detail: { type: "rate_limit_exceeded" } } }),
    )
    expect(result?.kind).toBe("rate-limited")
  })
  test("account_deactivated is permanent — credits-exhausted, never a timer retry", () => {
    const result = codex.classifyFailure(
      response(403, { body: { detail: { code: "account_deactivated", message: "plan is off" } } }),
    )
    expect(result?.kind).toBe("credits-exhausted")
    expect(result?.retryable).toBe(true)
    expect(result?.signal).toBe("openai-oauth:account_deactivated")
  })
  test("a bare string detail still yields a message, and falls back to the status", () => {
    const result = codex.classifyFailure(response(401, { body: { detail: "invalid token" } }))
    expect(result?.kind).toBe("auth")
    expect(result?.message).toBe("invalid token")
  })
  test("a body with no detail envelope falls back to the ordinary error reader", () => {
    const result = codex.classifyFailure(
      response(500, { body: { error: { message: "internal error" } } }),
    )
    expect(result?.kind).toBe("server-error")
    expect(result?.message).toBe("internal error")
  })
  test("a spent window's own countdown is provider-reported, not a guess", () => {
    const signal = codex.parseRateLimit(
      response(429, { body: { detail: { code: "usage_limit_reached" } }, headers: {} }),
    )
    const withCountdown = codex.parseRateLimit(
      response(429, { body: { resets_in_seconds: 120 }, headers: {} }),
    )
    expect(signal?.resetSource).toBe("unknown")
    expect(withCountdown?.retryAfterSeconds).toBe(120)
    expect(withCountdown?.resetSource).toBe("provider-reported")
    expect(withCountdown?.limited).toBe(true)
  })
  test("the nested error.resets_in_seconds form is read the same way", () => {
    const signal = codex.parseRateLimit(
      response(429, { body: { error: { resets_in_seconds: 45 } }, headers: {} }),
    )
    expect(signal?.retryAfterSeconds).toBe(45)
  })
})

describe("parseCodexQuotaHeaders — x-codex-* usage gauge", () => {
  const DATE = "Sat, 11 Oct 2026 12:00:00 GMT"
  const dateHeaders = { date: DATE }
  const futureReset = Math.floor(new Date("2026-10-11T17:00:00Z").getTime() / 1000)

  function setQuotedHandler(headers: Record<string, string>) {
    return response(200, { headers })
  }

  test("a 200 carrying both complete sets yields five_hour and seven_day windows, advisory", () => {
    const parsed = parseCodexQuotaHeaders(
      setQuotedHandler({
        ...dateHeaders,
        "x-codex-primary-used-percent": "12",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String(futureReset),
        "x-codex-secondary-used-percent": "60",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-at": String(futureReset + 86_400),
      }),
    )
    expect(parsed.quotaWindows).toHaveLength(2)
    const fiveHour = parsed.quotaWindows.find((w) => w.window === "five_hour")
    const sevenDay = parsed.quotaWindows.find((w) => w.window === "seven_day")
    expect(fiveHour).toBeDefined()
    expect(fiveHour?.utilization).toBeCloseTo(0.12)
    expect(fiveHour?.utilizationSource).toBe("continuous")
    expect(fiveHour?.resetSource).toBe("provider-reported")
    expect(fiveHour?.resetsAt).toBeInstanceOf(Date)
    expect(fiveHour?.advisory).toBe(true)
    expect(sevenDay).toBeDefined()
    expect(sevenDay?.utilization).toBeCloseTo(0.6)
    expect(sevenDay?.advisory).toBe(true)
  })

  test("only the primary set yields a single five_hour window", () => {
    const parsed = parseCodexQuotaHeaders(
      setQuotedHandler({
        ...dateHeaders,
        "x-codex-primary-used-percent": "12",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String(futureReset),
      }),
    )
    expect(parsed.quotaWindows).toHaveLength(1)
    expect(parsed.quotaWindows[0]?.window).toBe("five_hour")
    expect(parsed.windows).toHaveLength(0)
  })

  test("neither set yields no windows", () => {
    const parsed = parseCodexQuotaHeaders(setQuotedHandler({ ...dateHeaders }))
    expect(parsed.quotaWindows).toHaveLength(0)
    expect(parsed.windows).toHaveLength(0)
  })

  test("a non-numeric percent is dropped — no named window, no partial limiter entry", () => {
    const parsed = parseCodexQuotaHeaders(
      setQuotedHandler({
        ...dateHeaders,
        "x-codex-primary-used-percent": "abc",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String(futureReset),
      }),
    )
    // The set is incomplete: a malformed used-percent cannot claim a kind, and partial sets
    // must not become numbers ranking would consume. No window is produced.
    expect(parsed.quotaWindows).toHaveLength(0)
    expect(parsed.windows).toHaveLength(0)
  })

  test("a reset-at earlier than the reply's Date still reports a window, and is not spent", () => {
    const pastReset = Math.floor(new Date("2026-10-11T11:00:00Z").getTime() / 1000)
    const parsed = parseCodexQuotaHeaders(
      setQuotedHandler({
        ...dateHeaders,
        "x-codex-primary-used-percent": "50",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String(pastReset),
      }),
    )
    expect(parsed.quotaWindows).toHaveLength(1)
    const window = parsed.quotaWindows[0]
    expect(window?.window).toBe("five_hour")
    expect(window?.resetsAt?.getTime()).toBe(pastReset * 1000)
    // Advisory never blocks even when spent; that gate is `isWindowSpent`'s, not the parser's.
    expect(window?.advisory).toBe(true)
  })

  test("a window length of 60 minutes is reported in `windows`, not in `quotaWindows`", () => {
    const parsed = parseCodexQuotaHeaders(
      setQuotedHandler({
        ...dateHeaders,
        "x-codex-primary-used-percent": "5",
        "x-codex-primary-window-minutes": "60",
        "x-codex-primary-reset-at": String(futureReset),
      }),
    )
    expect(parsed.quotaWindows).toHaveLength(0)
    expect(parsed.windows.some((w) => w.limiter === "primary-60m")).toBe(true)
  })

  test("no Date header yields no named windows", () => {
    const parsed = parseCodexQuotaHeaders(
      setQuotedHandler({
        "x-codex-primary-used-percent": "12",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String(futureReset),
      }),
    )
    expect(parsed.quotaWindows).toHaveLength(0)
    expect(parsed.windows).toHaveLength(0)
  })

  test("an out-of-range reset-at (epoch overflow) produces no window at all", () => {
    // 99999999999999999 * 1000 overflows Date's range; the resulting `new Date(...)` is an Invalid
    // Date. Any window that consumed it would throw a RangeError at .toISOString() time. The parser
    // refuses the set entirely instead of poisoning downstream callers.
    const parsed = parseCodexQuotaHeaders(
      setQuotedHandler({
        ...dateHeaders,
        "x-codex-primary-used-percent": "12",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "99999999999999999",
      }),
    )
    expect(parsed.quotaWindows).toHaveLength(0)
    expect(parsed.windows).toHaveLength(0)
  })

  test("a float used-percent (12.5) yields a five_hour window with utilization 0.125", () => {
    // Upstream publishes used-percent as a float (`used_percent: f64` in codex-rs
    // `rate_limits.rs`); its own fixture sends `12.5`. A safe-integer parser would drop the
    // whole set, leaving the operator's view empty. The parser accepts any finite >= 0 and
    // downstream `clamp01` caps out-of-range, so 12.5 → 0.125 survives unchanged.
    const parsed = parseCodexQuotaHeaders(
      setQuotedHandler({
        ...dateHeaders,
        "x-codex-primary-used-percent": "12.5",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": String(futureReset),
      }),
    )
    expect(parsed.quotaWindows).toHaveLength(1)
    const window = parsed.quotaWindows[0]
    expect(window?.window).toBe("five_hour")
    expect(window?.utilization).toBeCloseTo(0.125)
  })

  test("a reset-at whose milliseconds overflow Date's range produces no window at all", () => {
    // 9000000000000 * 1000 = 9e15, above Date's 8.64e15 max. The value is a Number safe
    // integer so the integer check alone would accept it, but the Date built from it is
    // Invalid (`getTime()` returns NaN, which is not finite). The Date-range guard is what
    // catches this — and what an out-of-range epoch would throw at `.toISOString()` time
    // downstream if it did not.
    const parsed = parseCodexQuotaHeaders(
      setQuotedHandler({
        ...dateHeaders,
        "x-codex-primary-used-percent": "12",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "9000000000000",
      }),
    )
    expect(parsed.quotaWindows).toHaveLength(0)
    expect(parsed.windows).toHaveLength(0)
  })
})

describe("codex.parseRateLimit — the signal assembly", () => {
  const DATE = "Sat, 11 Oct 2026 12:00:00 GMT"
  const dateHeaders = { date: DATE }
  const futureReset = Math.floor(new Date("2026-10-11T17:00:00Z").getTime() / 1000)

  test("a 200 carrying both complete x-codex sets reports two quotaWindows and not limited", () => {
    const signal = codex.parseRateLimit(
      response(200, {
        headers: {
          ...dateHeaders,
          "x-codex-primary-used-percent": "12",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-at": String(futureReset),
          "x-codex-secondary-used-percent": "60",
          "x-codex-secondary-window-minutes": "10080",
          "x-codex-secondary-reset-at": String(futureReset + 86_400),
        },
      }),
    )
    expect(signal?.quotaWindows).toHaveLength(2)
    expect(signal?.limited).toBe(false)
  })

  test("a 200 carrying no headers at all returns null — nothing to fold", () => {
    // The change must not invent a signal where there was none: the prior parseRateLimitHeaders
    // returned null, foldRateLimit short-circuits on null, and an idle account stays idle.
    expect(codex.parseRateLimit(response(200, {}))).toBeNull()
  })

  test("a 200 carrying only a Date header returns null — the gauge is partial", () => {
    // A complete set is all three headers for one slot; the Date alone is not a reading.
    expect(codex.parseRateLimit(response(200, { headers: dateHeaders }))).toBeNull()
  })

  test("a 429 with the x-codex headers and `resets_in_seconds` is limited, provider-reported, and carries two quotaWindows", () => {
    const signal = codex.parseRateLimit(
      response(429, {
        headers: {
          ...dateHeaders,
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-at": String(futureReset),
          "x-codex-secondary-used-percent": "100",
          "x-codex-secondary-window-minutes": "10080",
          "x-codex-secondary-reset-at": String(futureReset + 86_400),
        },
        body: { resets_in_seconds: 120 },
      }),
    )
    expect(signal?.limited).toBe(true)
    expect(signal?.retryAfterSeconds).toBe(120)
    expect(signal?.resetSource).toBe("provider-reported")
    expect(signal?.quotaWindows).toHaveLength(2)
    // Each window is still advisory: a 100% reading does not block, and the operator's
    // display-only ruling survives the 429 path.
    for (const window of signal?.quotaWindows ?? []) {
      expect(window.advisory).toBe(true)
      expect(window.utilization).toBe(1)
    }
  })
})

describe("the device-code flow (codex-rs device_code_auth.rs)", () => {
  const device = openAiOAuthDriver.oauth?.device
  if (device === undefined) throw new Error("openai-oauth declares no device flow")

  test("endpoints, verification page and device redirect are pinned", () => {
    expect(device.verificationUrl).toBe("https://auth.openai.com/codex/device")
    expect(device.redirectUri).toBe("https://auth.openai.com/deviceauth/callback")
    expect(device.userCodeRequest()).toMatchObject({
      url: "https://auth.openai.com/api/accounts/deviceauth/usercode",
      method: "POST",
    })
    expect(JSON.parse(device.userCodeRequest().body)).toEqual({ client_id: OPENAI_OAUTH_CLIENT_ID })
    const poll = device.pollRequest({ deviceAuthId: "d", userCode: "U" })
    expect(poll.url).toBe("https://auth.openai.com/api/accounts/deviceauth/token")
    expect(JSON.parse(poll.body)).toEqual({ device_auth_id: "d", user_code: "U" })
  })

  test("the user code reads under either spelling; the interval is a string, a number, or absent", () => {
    expect(device.readUserCode({ device_auth_id: "d", user_code: "U", interval: "7" })).toEqual({
      deviceAuthId: "d",
      userCode: "U",
      intervalSeconds: 7,
    })
    expect(device.readUserCode({ device_auth_id: "d", usercode: "U", interval: 3 })?.userCode).toBe(
      "U",
    )
    expect(
      device.readUserCode({ device_auth_id: "d", user_code: "U", interval: "0" })?.intervalSeconds,
    ).toBeNull()
    expect(device.readUserCode({ device_auth_id: "d" })).toBeNull()
    expect(device.readUserCode({ user_code: "U" })).toBeNull()
  })

  test("403/404 pending, 429/5xx retry, 2xx carries the code, any other 4xx is final", () => {
    expect(device.readPoll(403, null)).toEqual({ kind: "pending" })
    expect(device.readPoll(404, null)).toEqual({ kind: "pending" })
    expect(
      device.readPoll(200, { authorization_code: "c", code_verifier: "v", code_challenge: "x" }),
    ).toEqual({ kind: "authorized", code: "c", codeVerifier: "v" })
    expect(device.readPoll(200, { authorization_code: "c" })).toEqual({ kind: "refused" })
    expect(device.readPoll(400, null)).toEqual({ kind: "refused" })
    expect(device.readPoll(429, null)).toEqual({
      kind: "retry",
      throttled: true,
      retryAfterSeconds: null,
    })
    expect(device.readPoll(429, null, new Headers({ "retry-after": "12" }))).toMatchObject({
      retryAfterSeconds: 12,
    })
    expect(device.readPoll(503, null)).toEqual({
      kind: "retry",
      throttled: false,
      retryAfterSeconds: null,
    })
    expect(device.readPoll(410, null)).toEqual({ kind: "refused" })
  })
})

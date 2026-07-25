import { describe, expect, test } from "bun:test"
import { UpstreamAuthError } from "@multi-ai-router/core"
import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_CODEX_BASE_URL,
  chatGptAccountId,
  httpDriver,
  OPENAI_AUTH_CLAIM,
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
  readOpenAiOAuthTokens,
} from "../../../src/providers"
import { account, response } from "./fixtures"

/**
 * `openai-oauth` — the ChatGPT/Codex subscription driver. Nothing here reaches a real endpoint:
 * the pinned constants, the two token-request shapes, and the `chatgpt-account-id` derivation are
 * exercised as pure functions, exactly the way `providers/drivers/openai-oauth.ts`'s own doc block
 * says a caller may rely on them.
 */

/** A synthetic, unsigned JWT: header.payload.signature, never a real token. */
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

    // resets_in_seconds lives alongside the detail envelope in the same body.
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

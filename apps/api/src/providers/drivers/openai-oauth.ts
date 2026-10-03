import { UpstreamAuthError } from "@multi-ai-router/core"
import { z } from "zod"
import { createHttpDriver } from "../driver"
import { codeRule, typeRule } from "../failure/classify"
import { readErrorFacts } from "../failure/error-body"
import { parseRateLimitHeaders } from "../rate-limit/parse"
import type {
  DriverAccount,
  OAuthTokenRequest,
  OAuthTokens,
  ProviderCredential,
  ProviderDriver,
  RateLimitSignal,
  UpstreamErrorFacts,
  UpstreamResponse,
} from "../types"

export const OPENAI_OAUTH_ISSUER = "https://auth.openai.com"
export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const OPENAI_OAUTH_AUTHORIZE_URL = `${OPENAI_OAUTH_ISSUER}/oauth/authorize`
export const OPENAI_OAUTH_TOKEN_URL = `${OPENAI_OAUTH_ISSUER}/oauth/token`

export const OPENAI_OAUTH_SCOPE = "openid profile email offline_access"
export const OPENAI_OAUTH_REFRESH_SCOPE = "openid profile email"

export const OPENAI_OAUTH_LOOPBACK_REDIRECT_URI = "http://localhost:1455/auth/callback"

export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
export const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth"
export const CHATGPT_ACCOUNT_ID_HEADER = "chatgpt-account-id"

export function openAiOAuthAuthorizeUrl(input: {
  readonly redirectUri: string
  readonly state: string
  readonly codeChallenge: string
}): URL {
  const url = new URL(OPENAI_OAUTH_AUTHORIZE_URL)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: OPENAI_OAUTH_SCOPE,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    state: input.state,
  }).toString()
  return url
}

export function openAiOAuthCodeExchange(input: {
  readonly code: string
  readonly redirectUri: string
  readonly codeVerifier: string
}): OAuthTokenRequest {
  return {
    url: OPENAI_OAUTH_TOKEN_URL,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code_verifier: input.codeVerifier,
    }).toString(),
  }
}

export function openAiOAuthRefresh(input: { readonly refreshToken: string }): OAuthTokenRequest {
  return {
    url: OPENAI_OAUTH_TOKEN_URL,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: OPENAI_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      scope: OPENAI_OAUTH_REFRESH_SCOPE,
    }),
  }
}

export interface OpenAiOAuthTokens extends OAuthTokens {
  readonly idToken: string | null
  readonly chatGptAccountId: string | null
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
})

export function readOpenAiOAuthTokens(
  body: unknown,
  context?: { readonly previousProviderAccountId?: string; readonly previousAccessToken?: string },
): OpenAiOAuthTokens | null {
  const parsed = TokenResponse.safeParse(body)
  if (!parsed.success) return null
  const { access_token, refresh_token, id_token, expires_in } = parsed.data
  const identity =
    chatGptAccountId({ idToken: id_token, accessToken: access_token }) ??
    normalizedIdentity(context?.previousProviderAccountId) ??
    accountIdIn(context?.previousAccessToken)
  return {
    ...(identity === null ? {} : { providerAccountId: identity }),
    accessToken: access_token,
    refreshToken: refresh_token ?? null,
    idToken: id_token ?? null,
    expiresInSeconds: expires_in ?? null,
    chatGptAccountId: identity,
  }
}

const AuthClaim = z.object({ chatgpt_account_id: z.string().trim().min(1).optional() })

function jwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1]
  if (payload === undefined || payload === "") return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    if (typeof parsed !== "object" || parsed === null) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function accountIdIn(token: string | null | undefined): string | null {
  if (token === null || token === undefined || token === "") return null
  const claims = jwtClaims(token)
  if (claims === null) return null
  const parsed = AuthClaim.safeParse(claims[OPENAI_AUTH_CLAIM])
  return parsed.success ? (parsed.data.chatgpt_account_id ?? null) : null
}

export interface ClaimTokens {
  readonly idToken?: string | null
  readonly accessToken?: string | null
}

export function chatGptAccountId(tokens: ClaimTokens): string | null {
  return accountIdIn(tokens.idToken) ?? accountIdIn(tokens.accessToken)
}

function requireChatGptAccountId(
  account: DriverAccount,
  credential: ProviderCredential | null,
): string {
  const accessToken = credential?.kind === "oauth" ? credential.accessToken : null
  const derived =
    (credential?.kind === "oauth" ? normalizedIdentity(credential.providerAccountId) : null) ??
    chatGptAccountId({ accessToken })
  if (derived !== null) return derived
  throw new UpstreamAuthError(
    `account ${account.id} (openai-oauth): no ChatGPT account id in the stored token, so the required ${CHATGPT_ACCOUNT_ID_HEADER} header cannot be sent — reconnect this account`,
  )
}

const DetailFacts = z.object({
  type: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
})
const DetailEnvelope = z.object({ detail: z.union([z.string(), DetailFacts]) })

export function readCodexFacts(body: unknown): UpstreamErrorFacts {
  const parsed = DetailEnvelope.safeParse(body)
  if (!parsed.success) return readErrorFacts(body)
  const detail = parsed.data.detail
  return typeof detail === "string" ? { message: detail } : detail
}

const ResetsIn = z.object({
  error: z.object({ resets_in_seconds: z.number().nonnegative() }).optional(),
  resets_in_seconds: z.number().nonnegative().optional(),
})

function resetsInSeconds(body: unknown): number | null {
  const parsed = ResetsIn.safeParse(body)
  if (!parsed.success) return null
  return parsed.data.error?.resets_in_seconds ?? parsed.data.resets_in_seconds ?? null
}

const LIMITED_NO_WINDOWS: RateLimitSignal = { limited: true, resetSource: "unknown", windows: [] }

function parseCodexRateLimit(response: UpstreamResponse): RateLimitSignal | null {
  const fromHeaders = parseRateLimitHeaders(response)
  const seconds = resetsInSeconds(response.body)
  if (seconds === null) return fromHeaders

  const signal = fromHeaders ?? LIMITED_NO_WINDOWS
  return {
    ...signal,
    limited: true,
    retryAfterSeconds: signal.retryAfterSeconds ?? seconds,
    resetSource: "provider-reported",
  }
}

const LIMIT_CODES = ["usage_limit_reached", "rate_limit_exceeded"]
const DEACTIVATED_CODES = ["account_deactivated"]

const codex = createHttpDriver({
  id: "openai-oauth",
  authKind: "oauth",
  // A ChatGPT plan is the flat monthly fee itself: there is no per-token price on this surface at
  // all, so its usage prices as an attribution against the OpenAI API table, never as spend.
  billing: "subscription",
  surfaces: [{ dialect: "openai-responses", baseUrl: CHATGPT_CODEX_BASE_URL }],
  readFacts: readCodexFacts,
  parseRateLimit: parseCodexRateLimit,
  rules: [
    typeRule("rate-limited", "openai-oauth:usage_limit_reached", LIMIT_CODES),
    codeRule("rate-limited", "openai-oauth:usage_limit_reached", LIMIT_CODES),
    typeRule("credits-exhausted", "openai-oauth:account_deactivated", DEACTIVATED_CODES),
    codeRule("credits-exhausted", "openai-oauth:account_deactivated", DEACTIVATED_CODES),
  ],
})

export const openAiOAuthDriver: ProviderDriver = {
  ...codex,
  oauth: {
    loopbackRedirectUri: OPENAI_OAUTH_LOOPBACK_REDIRECT_URI,
    authorizeUrl: openAiOAuthAuthorizeUrl,
    codeExchange: openAiOAuthCodeExchange,
    refresh: openAiOAuthRefresh,
    readTokens: (body, context) => {
      const tokens = readOpenAiOAuthTokens(body, context)
      return tokens?.providerAccountId === undefined ? null : tokens
    },
  },
  buildHeaders: (account, credential) => {
    const headers = codex.buildHeaders(account, credential)
    headers.set(CHATGPT_ACCOUNT_ID_HEADER, requireChatGptAccountId(account, credential))
    return headers
  },
}

function normalizedIdentity(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

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

/**
 * `openai-oauth` — a ChatGPT/Codex **subscription**, reached over ordinary HTTP with a token this
 * router holds and refreshes. (Claude subscriptions are the opposite case: their tokens stay inside
 * the Agent SDK and never come near this file — CLAUDE.md non-negotiable 1.)
 *
 * This is a **reverse-engineered flow**, so everything the provider could change lives here and
 * nowhere else: endpoints, client id, scopes, the two token-request shapes, and how the required
 * `chatgpt-account-id` is derived. The connect flow and the refresher own the timers, the storage,
 * and the single-flighting; they never restate a URL or a body shape.
 *
 * Two traps are encoded below rather than left for a caller to rediscover. **The two token requests
 * do not agree**: the code exchange is `x-www-form-urlencoded`, the refresh is a JSON body, either
 * in the other's encoding fails. And **`chatgpt-account-id` is derived, never configured** — read
 * from the `id_token` claims (falling back to the `access_token`, same namespace) and re-derived on
 * every refresh, because a rotated token can carry a different id.
 */

/**
 * Provenance: docs/idea/03-providers.md, "`openai-oauth` — ChatGPT/Codex subscription"; the values
 * match the first-party client's own flow. Blast radius: a wrong issuer or client id is rejected
 * before the operator ever sees a consent screen, and every connected account stops refreshing.
 */
export const OPENAI_OAUTH_ISSUER = "https://auth.openai.com"
export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const OPENAI_OAUTH_AUTHORIZE_URL = `${OPENAI_OAUTH_ISSUER}/oauth/authorize`
export const OPENAI_OAUTH_TOKEN_URL = `${OPENAI_OAUTH_ISSUER}/oauth/token`

/**
 * Provenance: same table. `offline_access` is what earns the refresh token. Blast radius: without
 * it an account works until first expiry and then degrades to `needs_reauth` with no way back but a
 * human re-login. The refresh asks for less on purpose: it does not re-issue the grant, and the
 * first-party client omits `offline_access` there.
 */
export const OPENAI_OAUTH_SCOPE = "openid profile email offline_access"
export const OPENAI_OAUTH_REFRESH_SCOPE = "openid profile email"

/**
 * Provenance: the loopback redirect the first-party client registers; the issuer accepts only
 * registered values. Blast radius: an operator-supplied `PUBLIC_URL` callback may be refused, and
 * then this is the address the manual `code#state` paste mode names — paste is first-class here.
 */
export const OPENAI_OAUTH_LOOPBACK_REDIRECT_URI = "http://localhost:1455/auth/callback"

/**
 * Provenance: docs/idea/03-providers.md registry table — the Codex surface of the ChatGPT backend,
 * speaking OpenAI Responses (`<base>/responses`); plus the namespaced claim OpenAI issues its
 * ChatGPT identity under and the header that surface requires on every call. Blast radius: the base
 * URL is every request; if the claim moves, no id can be derived and the account needs re-auth.
 */
export const CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
export const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth"
export const CHATGPT_ACCOUNT_ID_HEADER = "chatgpt-account-id"

/**
 * `state` is one-shot and server-side; the S256 verifier behind `codeChallenge` never leaves the
 * router until the exchange (docs/idea/07-security.md). `id_token_add_organizations=true` mirrors
 * the first-party client: it enriches the `https://api.openai.com/auth` claim the account id is
 * read from. Blast radius if the issuer stops honoring it: the id_token may omit the claim and
 * derivation falls back to the access token.
 */
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

/** The code exchange is **form-encoded**. Its sibling below is not; that asymmetry is the trap. */
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

/** The refresh is a **JSON body**, and no `redirect_uri` or verifier is involved. */
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

/** The shared shape plus what only this provider carries. Both extras are derived, never configured. */
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

/** Zod at the boundary: a reshaped payload yields `null`, never a half-populated token set. */
export function readOpenAiOAuthTokens(body: unknown): OpenAiOAuthTokens | null {
  const parsed = TokenResponse.safeParse(body)
  if (!parsed.success) return null
  const { access_token, refresh_token, id_token, expires_in } = parsed.data
  return {
    accessToken: access_token,
    refreshToken: refresh_token ?? null,
    idToken: id_token ?? null,
    expiresInSeconds: expires_in ?? null,
    chatGptAccountId: chatGptAccountId({ idToken: id_token, accessToken: access_token }),
  }
}

const AuthClaim = z.object({ chatgpt_account_id: z.string().trim().min(1).optional() })

/** Claims only — the signature is the issuer's business, and this router never trusts the payload. */
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

/** Whichever tokens the caller has: at connect it holds both, on a request only the access token. */
export interface ClaimTokens {
  readonly idToken?: string | null
  readonly accessToken?: string | null
}

/** `id_token` first, `access_token` second — both carry the namespace, the id_token more reliably. */
export function chatGptAccountId(tokens: ClaimTokens): string | null {
  return accountIdIn(tokens.idToken) ?? accountIdIn(tokens.accessToken)
}

/**
 * Refusing beats sending: a request with no `chatgpt-account-id` is a 401/403 the operator would
 * read as a bad token. `UpstreamAuthError` names it for what it is, the chain fails over to the
 * next candidate, and no token material reaches the message.
 */
function requireChatGptAccountId(account: DriverAccount, credential: ProviderCredential): string {
  const accessToken = credential.kind === "oauth" ? credential.accessToken : null
  const derived = chatGptAccountId({ accessToken })
  if (derived !== null) return derived
  throw new UpstreamAuthError(
    `account ${account.id} (openai-oauth): no ChatGPT account id in the stored token, so the required ${CHATGPT_ACCOUNT_ID_HEADER} header cannot be sent — reconnect this account`,
  )
}

/**
 * Provenance: the ChatGPT backend words some failures as `detail`, not the OpenAI `error` envelope.
 * Blast radius: without this the body yields no facts and classification falls back to bare status.
 */
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

/**
 * Provenance: `resets_in_seconds` is the countdown the first-party client shows when a window is
 * spent. Blast radius: without it a spent window cools down on the breaker's guess instead of the
 * provider's own number. Headers first, then the body — and still never estimating: a duration the
 * provider stated is `provider-reported`, and the instant it lands on is routing's, with a clock.
 */
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

/**
 * A subscription has no balance to drain, so nearly every refusal here is clock-recoverable — a
 * spent 5-hour or weekly window, not a dead account. A deactivated plan is the exception: permanent
 * until a human acts, so `credits-exhausted` (`402`, never retried on a timer) rather than a
 * cooldown that never clears (CLAUDE.md non-negotiable 7).
 */
const LIMIT_CODES = ["usage_limit_reached", "rate_limit_exceeded"]
const DEACTIVATED_CODES = ["account_deactivated"]

const codex = createHttpDriver({
  id: "openai-oauth",
  authKind: "oauth",
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

/**
 * Everything shared, plus the one header no other provider needs and the flow that connects an
 * account. `oauth` is the same four builders above under their provider-independent names, so
 * `services/accounts/connect/oauth.ts` drives this flow without naming this provider.
 */
export const openAiOAuthDriver: ProviderDriver = {
  ...codex,
  oauth: {
    loopbackRedirectUri: OPENAI_OAUTH_LOOPBACK_REDIRECT_URI,
    authorizeUrl: openAiOAuthAuthorizeUrl,
    codeExchange: openAiOAuthCodeExchange,
    refresh: openAiOAuthRefresh,
    readTokens: readOpenAiOAuthTokens,
  },
  buildHeaders: (account, credential) => {
    const headers = codex.buildHeaders(account, credential)
    headers.set(CHATGPT_ACCOUNT_ID_HEADER, requireChatGptAccountId(account, credential))
    return headers
  },
}

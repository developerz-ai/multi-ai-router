import type {
  AuthKind,
  Dialect,
  OpenAiChatCeiling,
  ProviderId,
  QuotaWindowState,
  ResetSource,
  UtilizationSource,
} from "@multi-ai-router/core"
import type { ModelAliasMap } from "@multi-ai-router/db"

/**
 * The provider driver contract: one interface, many implementations. Adding a provider is one
 * file under `drivers/` plus one line in `registry.ts` — nothing else in the system changes
 * (docs/idea/03-providers.md, "Adding a provider").
 *
 * Every member here is **pure**: no clock, no store, no logger, no network. A driver decides how
 * a request is addressed and authenticated and what an upstream response *means*; what to do
 * about it is routing's job (docs/idea/05-routing-and-failover.md).
 *
 * Two members from the design doc are deliberately absent. `probeHealth` is I/O, owned by the
 * half-open probe. `refreshCredentials` would be I/O too, and `openai-oauth` shows why it does not
 * belong here: its driver file owns the token-request *shapes* as pure builders, while the fetch,
 * the timers, and the single-flighting live in `services/accounts/`. Both stay additive.
 */

/**
 * The slice of an Account a driver is allowed to see. Deliberately not the DB row: a driver has
 * no business reading `status`, `weight`, or credential ciphertext.
 */
export interface DriverAccount {
  readonly id: string
  readonly provider: ProviderId
  /**
   * Operator override of the provider's pinned endpoint — what makes a self-hosted or regional
   * endpoint work without a new driver. Required for the `*-compatible` escape hatches.
   */
  readonly baseUrl?: string | null
  /**
   * Which wire surface this Account uses, where the provider exposes more than one (z.ai speaks
   * Anthropic *or* OpenAI). Ignored by single-surface providers.
   */
  readonly dialect?: Dialect | null
  /** `sonnet` -> `glm-4.7`. Absent, or absent for a name, means the name passes through. */
  readonly modelAliases?: ModelAliasMap | null
}

/**
 * Decrypted credential material, as the driver needs it. The two forms are not interchangeable
 * on the Anthropic dialect — see `auth-headers.ts`.
 *
 * Claude *subscription* credentials never appear here: they live inside the Account's
 * `CLAUDE_CONFIG_DIR` and are owned by the Agent SDK (docs/idea/11-anthropic-agent-sdk.md).
 */
export type ProviderCredential =
  | { readonly kind: "api-key"; readonly apiKey: string }
  | { readonly kind: "oauth"; readonly accessToken: string }

/**
 * What a driver is shown of an upstream response. `body` is present only when the caller already
 * read one — which it does on the error path, never on a streaming success, because buffering a
 * stream is forbidden (docs/idea/06-protocol-translation.md, performance rules).
 */
export interface UpstreamResponse {
  readonly status: number
  readonly headers: Headers
  readonly body?: unknown
}

/**
 * One limiter's reading. `limiter` is the provider's own name for the window (`requests`,
 * `tokens`, `input-tokens`, …) rather than an enum, because the set differs per provider and
 * inventing a mapping would lose information the operator needs.
 */
export interface RateLimitWindow {
  readonly limiter: string
  readonly limit?: number
  readonly remaining?: number
  /** Fraction of the window consumed, 0..1. Absent when the provider reported no headroom. */
  readonly utilization?: number
  readonly utilizationSource: UtilizationSource
  readonly resetsAt?: Date
  readonly resetAfterSeconds?: number
  readonly resetSource: ResetSource
}

/**
 * Normalized rate-limit / quota reading. Drivers never estimate: `resetSource` is
 * `provider-reported` when the upstream said something and `unknown` when it did not. Turning
 * "unknown" into a backoff guess is the circuit breaker's decision, not a driver's.
 */
export interface RateLimitSignal {
  /** The upstream says this credential is limited *now*. */
  readonly limited: boolean
  readonly retryAfterSeconds?: number
  readonly resetsAt?: Date
  readonly resetSource: ResetSource
  readonly windows: readonly RateLimitWindow[]
  /**
   * The same reading in the router's own window vocabulary, for the providers that speak it.
   *
   * This is the **only** channel by which an Account's `quotaWindows` are ever written: the health
   * store folds it in exactly as it folds in `windows`, and everything downstream — the filter's
   * `quota-window-spent`, `quota-aware`'s ranking, the console's per-window countdowns — reads what
   * lands there and nothing else.
   *
   * Absent for every HTTP driver, and that absence is the design, not a gap: `requests` and
   * `input-tokens` have no `QuotaWindowKind` equivalent, so naming one would record a fact the
   * provider never stated. They travel as {@link windows}, keeping the provider's own word. Absent
   * also differs from empty: absent says "nothing to report about named windows" and leaves what is
   * already known standing, where `[]` would claim this account has none.
   */
  readonly quotaWindows?: readonly QuotaWindowState[]
}

/**
 * The outcomes an upstream failure can have. `rate-limited` and `credits-exhausted` are separate
 * for the same reason `QuotaExhaustedError` and `CreditsExhaustedError` are: a clock fixes the
 * first, only a human fixes the second.
 *
 * The last three exist only on the Agent-SDK transport, and they are named rather than folded into
 * `server-error` because each one has a *different recovery* — replay this account, wait then fork,
 * or give up on the subprocess (docs/idea/11-anthropic-agent-sdk.md §9). A single `server-error`
 * would make all three retry the same wrong way.
 */
export const UPSTREAM_FAILURE_KINDS = [
  "rate-limited",
  "credits-exhausted",
  "auth",
  "invalid-request",
  "server-error",
  /** The SDK no longer holds the session we resumed. Evict the binding, replay once in place. */
  "stale-session",
  /** The SDK session is still running as a background agent. Bounded waits, then fork it. */
  "busy-session",
  /** The `claude` subprocess died. Reported honestly, never re-read as an auth failure. */
  "subprocess-crash",
  "unknown",
] as const

export type UpstreamFailureKind = (typeof UPSTREAM_FAILURE_KINDS)[number]

/** The provider-independent facts read out of a provider-shaped error body. */
export interface UpstreamErrorFacts {
  readonly type?: string
  readonly code?: string
  readonly message?: string
}

export interface FailureClassification {
  readonly kind: UpstreamFailureKind
  readonly status: number
  /**
   * Whether the router may try the **next candidate account**. Never the same account, and never
   * once bytes have reached the client (docs/idea/05-routing-and-failover.md).
   */
  readonly retryable: boolean
  /**
   * Which signal decided this — `http-status:429`, `openai:insufficient_quota`,
   * `minimax:base_resp-1008`. Recorded so a misclassification is debuggable rather than a mystery.
   */
  readonly signal: string
  /** The upstream's own message, when it gave one. Never rendered into a client-facing error. */
  readonly message?: string
  readonly rateLimit: RateLimitSignal | null
}

/** A ready-to-send token-endpoint call. The caller owns the fetch; the driver owns the shape. */
export interface OAuthTokenRequest {
  readonly url: string
  readonly method: "POST"
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/**
 * What a token endpoint said, provider-independently. A `null` field means the issuer said
 * nothing about it — refresh-token rotation and expiry reporting both vary by provider — and what
 * that means is the caller's call: a refresh keeps what the Account holds, a fresh authorization
 * replaces it.
 */
export interface OAuthTokens {
  readonly accessToken: string
  readonly refreshToken: string | null
  readonly expiresInSeconds: number | null
}

/**
 * The authorization-code + PKCE flow a provider's subscription is connected with, as pure
 * builders. A driver that advertises this is connectable through
 * `services/accounts/connect/oauth.ts`, and that service names no provider — which is what keeps
 * adding an OAuth provider to one file under `drivers/` (CLAUDE.md non-negotiable 12).
 *
 * Shapes only, exactly like the rest of this interface: the fetch, the one-shot `state`, the TTL,
 * and the refresh timers live in `services/accounts/`.
 */
export interface ProviderOAuthFlow {
  /**
   * The redirect the provider's own first-party client registers. Used when the operator has no
   * reachable `PUBLIC_URL`: the browser lands on a dead loopback page whose address bar still
   * carries `code` and `state`, and the operator pastes that back.
   */
  readonly loopbackRedirectUri: string
  authorizeUrl(input: {
    readonly redirectUri: string
    readonly state: string
    readonly codeChallenge: string
  }): URL
  codeExchange(input: {
    readonly code: string
    readonly redirectUri: string
    readonly codeVerifier: string
  }): OAuthTokenRequest
  refresh(input: { readonly refreshToken: string }): OAuthTokenRequest
  /** Zod at the boundary: a reshaped payload yields `null`, never a half-populated token set. */
  readTokens(body: unknown): OAuthTokens | null
}

export interface ProviderDriver {
  readonly id: ProviderId
  /** The surface used when the Account expresses no preference. */
  readonly dialect: Dialect
  readonly authKind: AuthKind
  /**
   * Present only where the router connects an account by driving an authorization-code flow
   * itself. Absent for API-key providers, and absent for Claude subscriptions for a stronger
   * reason: their exchange belongs to the `claude` CLI (non-negotiable 1).
   */
  readonly oauth?: ProviderOAuthFlow

  /** Account override wins over the pinned default. Throws when neither exists. */
  resolveBaseUrl(account: DriverAccount): URL

  /** The Account's chosen surface, for the passthrough-vs-translate decision. */
  resolveDialect(account: DriverAccount): Dialect

  /**
   * Which spelling of the openai-chat output ceiling this Account's surface accepts — the one field
   * of that dialect two vendors name differently (`OpenAiChatCeiling`).
   *
   * Read only when the router *writes* an openai-chat body, so a driver whose surfaces speak
   * something else answers with the default and is never asked again.
   */
  resolveChatCeiling(account: DriverAccount): OpenAiChatCeiling

  /**
   * Auth plus every provider-mandated header. Never mutates the Account, never logs.
   *
   * `null` is an Account of a provider whose `authKind` is `none` holding no credential — a local
   * endpoint that authenticates nobody. The mandated headers still go; the auth header does not.
   * Every other provider receiving `null` here is a bug, and is refused rather than sent
   * unauthenticated (`driver.ts`).
   */
  buildHeaders(account: DriverAccount, credential: ProviderCredential | null): Headers

  /** Client model name -> upstream model id. Identity when the Account has no entry. */
  mapModelAlias(account: DriverAccount, requestedModel: string): string

  /** Rate-limit / quota signals out of one response. `null` when the provider said nothing. */
  parseRateLimit(response: UpstreamResponse): RateLimitSignal | null

  /**
   * What this response means as a failure, or `null` if it is not one. Accepts a 2xx because
   * some providers (MiniMax) report a dead balance in the body of a `200`.
   */
  classifyFailure(response: UpstreamResponse): FailureClassification | null
}

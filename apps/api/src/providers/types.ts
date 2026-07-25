import type {
  AuthKind,
  Dialect,
  ProviderId,
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

export interface ProviderDriver {
  readonly id: ProviderId
  /** The surface used when the Account expresses no preference. */
  readonly dialect: Dialect
  readonly authKind: AuthKind

  /** Account override wins over the pinned default. Throws when neither exists. */
  resolveBaseUrl(account: DriverAccount): URL

  /** The Account's chosen surface, for the passthrough-vs-translate decision. */
  resolveDialect(account: DriverAccount): Dialect

  /** Auth plus every provider-mandated header. Never mutates the Account, never logs. */
  buildHeaders(account: DriverAccount, credential: ProviderCredential): Headers

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

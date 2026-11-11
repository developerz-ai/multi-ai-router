import type {
  AccountBilling,
  AuthKind,
  Dialect,
  OpenAiChatCeiling,
  ProviderId,
} from "@multi-ai-router/core"
import type { ModelAliasMap } from "@multi-ai-router/db"
import type { ModelFamily } from "../services/routing/model-family"
import type { ResponsesEgressRules } from "../services/translate/shared/responses-egress"
import type {
  FailureClassification,
  RateLimitSignal,
  ResponseObservationDescriptor,
} from "./failure-types"
import type { ProviderModelListing } from "./model-listing"
import type { ProviderOAuthFlow } from "./oauth-types"
import type { ProviderQuotaRead } from "./quota-read"

export type {
  FailureClassification,
  RateLimitSignal,
  RateLimitWindow,
  ResponseObservationDescriptor,
  UpstreamErrorFacts,
  UpstreamFailureKind,
} from "./failure-types"
export { UPSTREAM_FAILURE_KINDS } from "./failure-types"
export type { OAuthTokenRequest, OAuthTokens, ProviderOAuthFlow } from "./oauth-types"

/**
 * The provider driver contract: one interface, many implementations. Adding a provider is one
 * file under `drivers/`, its id in the `ProviderId` union (`packages/core`), and one line in
 * `registry.ts` (docs/idea/03-providers.md, "Adding a provider"). A fact about a provider that some
 * service needs — a catalog sweep it must not get, a probe model, how its shipped prices read — is a
 * member here, never a provider-id comparison in that service (non-negotiable 12).
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
  | { readonly kind: "oauth"; readonly accessToken: string; readonly providerAccountId?: string }

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

export interface ProviderDriver {
  readonly responseObservation?: ResponseObservationDescriptor
  readonly id: ProviderId
  /** The surface used when the Account expresses no preference. */
  readonly dialect: Dialect
  readonly authKind: AuthKind
  /**
   * What an Account of this provider is billed as unless the operator says otherwise — the default
   * a new Account takes, and a fixed answer where the value is `subscription`. A fact about the
   * provider, so it lives on the driver (non-negotiable 12), not in the cost estimator.
   */
  readonly billing: AccountBilling
  /**
   * Present only where the router connects an account by driving an authorization-code flow
   * itself. Absent for API-key providers, and absent for Claude subscriptions for a stronger
   * reason: their exchange belongs to the `claude` CLI (non-negotiable 1).
   */
  readonly oauth?: ProviderOAuthFlow
  /** A non-stock model listing (`model-listing.ts`). Absent: `{data: [{id}]}` at `/models`. */
  readonly modelListing?: ProviderModelListing
  /** A plan-usage endpoint read off the request path (`quota-read.ts`). Absent: nothing to read. */
  readonly quotaRead?: ProviderQuotaRead
  /**
   * The names an Account of this provider serves when its operator declared no `supportedModels`
   * (`services/routing/model-family.ts`). Only a single-vendor upstream — a subscription — declares
   * one; absent keeps the account a passthrough for every name.
   */
  readonly modelFamily?: ModelFamily
  /**
   * True when the upstream reads a Claude Code context tag (`opus[1m]`) on a model name itself.
   * Absent: routing strips the tag and sends the base name (`services/routing/context-tag.ts`).
   */
  readonly understandsContextTags?: boolean
  /**
   * `manual`: the hourly catalog sweep never lists this provider; only the operator's discover
   * button does (`services/models/refresh.ts`). For an aggregator whose listing is someone else's
   * catalog. Absent: swept like any HTTP account.
   */
  readonly catalogSweep?: "manual"
  /**
   * The model the idle-account keepalive/probe spends its one minimal turn on
   * (`scheduler/tasks/idle-account-probe.ts`). Absent: this provider is never probed idle.
   */
  readonly idleProbeModel?: string
  /**
   * How the shipped price table for this provider reads (`services/cost/prices.ts`). Absent: list
   * prices, family fallback allowed. `notional`: the rows are a list-price *attribution* for a
   * flat-fee plan, not a meter — priced only for a `subscription`-billed account and never for a
   * cache write (the plan publishes no write rate), exact model name only (no family fallback), and
   * listed to the console as `notionalOnly`.
   */
  readonly shippedPrices?: "notional"

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

  /** What this Account's Responses surface demands of a body the router writes. Pure, in-memory. */
  resolveResponsesEgress(account: DriverAccount): ResponsesEgressRules

  /**
   * Whether this Account's anthropic surface thinks by default and ignores a forced `tool_choice`
   * while it does (`ProviderSurface.thinkingOnByDefault`). Absent means no.
   */
  thinkingOnByDefault?(account: DriverAccount): boolean

  /**
   * Whether this upstream model on this Account's anthropic surface runs only with thinking on
   * (`ProviderSurface.thinkingRequiredModels`), so `thinking: {type: "disabled"}` is refused. Absent
   * means no model requires it.
   */
  requiresThinking?(account: DriverAccount, upstreamModel: string): boolean

  /**
   * Whether this Account's surface keys its prompt cache by the body's `prompt_cache_key`
   * (`ProviderSurface.bodyCacheKey`), so a translated body is sent one. Absent means no.
   */
  keysPromptCacheByBody?(account: DriverAccount): boolean

  /**
   * Whether this Account's surface reads `cache_control` beyond its dialect's base on a written body
   * (`ProviderSurface.cacheControl`). Absent means no.
   */
  carriesCacheControl?(account: DriverAccount): boolean

  /**
   * Whether this Account's surface reads a body `session_id` as its sticky-routing key
   * (`ProviderSurface.bodySessionId`), so a translated body is sent one. Absent means no.
   */
  keysSessionByBody?(account: DriverAccount): boolean

  /**
   * The header this Account's surface requires to name the conversation
   * (`ProviderSurface.sessionHeader`). Absent or `undefined` means none is sent.
   */
  sessionHeader?(account: DriverAccount): string | undefined

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

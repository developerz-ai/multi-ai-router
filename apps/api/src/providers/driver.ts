import {
  type AccountBilling,
  type AuthKind,
  CredentialDecryptError,
  DEFAULT_ACCOUNT_BILLING,
  DEFAULT_OPENAI_CHAT_CEILING,
  type Dialect,
  type OpenAiChatCeiling,
  type ProviderId,
} from "@multi-ai-router/core"
import { type AnthropicAuthForm, anthropicAuthHeaders, bearerAuthHeaders } from "./auth-headers"
import { resolveBaseUrl } from "./base-url"
import { type ClassificationRule, classifyUpstreamFailure } from "./failure/classify"
import { readErrorFacts } from "./failure/error-body"
import { mapModelAlias } from "./model-alias"
import { parseRateLimitHeaders } from "./rate-limit/parse"
import type {
  DriverAccount,
  ProviderCredential,
  ProviderDriver,
  RateLimitSignal,
  UpstreamErrorFacts,
  UpstreamResponse,
} from "./types"

/**
 * The shared body of every HTTP driver. A provider file declares its surfaces and how it words a
 * dead balance; everything else — alias mapping, base-URL override, header rules, rate-limit
 * headers, status defaults — is composed from here rather than copied.
 *
 * Not a framework: a driver that needs something this cannot express supplies its own
 * `readFacts` or `parseRateLimit` (MiniMax does), or implements `ProviderDriver` directly.
 */

/**
 * One wire surface a provider exposes. Most have exactly one; z.ai has two, and which one an
 * Account uses decides both its endpoint *and* its auth header form, which is why the two travel
 * together.
 */
export interface ProviderSurface {
  readonly dialect: Dialect
  /** Pinned default. `null` where the operator must supply one (the `*-compatible` hatches). */
  readonly baseUrl: string | null
  /**
   * Anthropic-dialect surfaces only: whose endpoint this is. `vendor-bearer` for a compatible
   * vendor's Anthropic-shaped endpoint, which takes the key as a Bearer token and never the
   * OAuth beta. Defaults to Anthropic's own rules. See `auth-headers.ts`.
   */
  readonly anthropicAuth?: AnthropicAuthForm
  /**
   * openai-chat surfaces only: which spelling of the output ceiling this endpoint accepts. Defaults
   * to `max_tokens`, the name every OpenAI-compatible vendor states — a provider states the other
   * one here only where its own reference does, because guessing wrong drops the caller's ceiling
   * silently in one direction and `400`s in the other (`OpenAiChatCeiling`).
   */
  readonly chatCeiling?: OpenAiChatCeiling
}

export interface HttpDriverConfig {
  readonly id: ProviderId
  /**
   * Defaults to `api-key`: most HTTP drivers here are a key, not a token. `none` is the local
   * endpoint that authenticates nobody, and the only value under which this driver will address an
   * upstream with no credential at all.
   */
  readonly authKind?: AuthKind
  /**
   * What an Account of this provider is billed as unless the operator says otherwise. Defaults to
   * `metered`: every HTTP driver here except the ChatGPT/Codex one sells tokens by the token.
   *
   * A provider that states `subscription` is sold *only* that way and its accounts are fixed there
   * — there is no per-token price to meter. The reverse is not true, which is why this is a default
   * rather than the answer: a metered provider's key may be attached to a flat-fee coding plan, and
   * that is the operator's fact to record on the Account (`services/accounts/rules.ts`).
   */
  readonly billing?: AccountBilling
  /** First entry is the default surface — the one an Account with no preference gets. */
  readonly surfaces: readonly [ProviderSurface, ...ProviderSurface[]]
  readonly rules?: readonly ClassificationRule[]
  readonly readFacts?: (body: unknown) => UpstreamErrorFacts
  readonly parseRateLimit?: (response: UpstreamResponse) => RateLimitSignal | null
}

function surfaceHeaders(surface: ProviderSurface, credential: ProviderCredential | null): Headers {
  if (surface.dialect === "anthropic") {
    return anthropicAuthHeaders(credential, surface.anthropicAuth)
  }
  return bearerAuthHeaders(credential)
}

/**
 * The one thing a nullable credential must never become: an anonymous request to a provider that
 * expects one. `authKind: "none"` is the whole permission, and anything else arriving here with
 * nothing to present is a router bug — loud, and never a key-less call upstream.
 */
function requireCredential(
  config: HttpDriverConfig,
  account: DriverAccount,
  credential: ProviderCredential | null,
): void {
  if (credential !== null || (config.authKind ?? "api-key") === "none") return
  throw new CredentialDecryptError(
    `account ${account.id}: provider "${config.id}" authenticates with a credential and this account holds none`,
  )
}

export function createHttpDriver(config: HttpDriverConfig): ProviderDriver {
  const [defaultSurface] = config.surfaces
  const parseRateLimit = config.parseRateLimit ?? parseRateLimitHeaders
  const classifyOptions = {
    rules: config.rules ?? [],
    readFacts: config.readFacts ?? readErrorFacts,
    parseRateLimit,
  }

  const surfaceFor = (account: DriverAccount): ProviderSurface =>
    config.surfaces.find((surface) => surface.dialect === account.dialect) ?? defaultSurface

  return {
    id: config.id,
    dialect: defaultSurface.dialect,
    authKind: config.authKind ?? "api-key",
    billing: config.billing ?? DEFAULT_ACCOUNT_BILLING,
    resolveBaseUrl: (account) => resolveBaseUrl(account, surfaceFor(account).baseUrl),
    resolveDialect: (account) => surfaceFor(account).dialect,
    resolveChatCeiling: (account) => surfaceFor(account).chatCeiling ?? DEFAULT_OPENAI_CHAT_CEILING,
    buildHeaders: (account, credential) => {
      requireCredential(config, account, credential)
      return surfaceHeaders(surfaceFor(account), credential)
    },
    mapModelAlias,
    parseRateLimit,
    classifyFailure: (response) => classifyUpstreamFailure(classifyOptions, response),
  }
}

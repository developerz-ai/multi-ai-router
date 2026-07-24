import type { AuthKind, Dialect, ProviderId } from "@multi-ai-router/core"
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
}

export interface HttpDriverConfig {
  readonly id: ProviderId
  /** Defaults to `api-key`: every HTTP driver in the registry today is a key, not a token. */
  readonly authKind?: AuthKind
  /** First entry is the default surface — the one an Account with no preference gets. */
  readonly surfaces: readonly [ProviderSurface, ...ProviderSurface[]]
  readonly rules?: readonly ClassificationRule[]
  readonly readFacts?: (body: unknown) => UpstreamErrorFacts
  readonly parseRateLimit?: (response: UpstreamResponse) => RateLimitSignal | null
}

function surfaceHeaders(surface: ProviderSurface, credential: ProviderCredential): Headers {
  if (surface.dialect === "anthropic") {
    return anthropicAuthHeaders(credential, surface.anthropicAuth)
  }
  return bearerAuthHeaders(credential)
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
    resolveBaseUrl: (account) => resolveBaseUrl(account, surfaceFor(account).baseUrl),
    resolveDialect: (account) => surfaceFor(account).dialect,
    buildHeaders: (account, credential) => surfaceHeaders(surfaceFor(account), credential),
    mapModelAlias,
    parseRateLimit,
    classifyFailure: (response) => classifyUpstreamFailure(classifyOptions, response),
  }
}

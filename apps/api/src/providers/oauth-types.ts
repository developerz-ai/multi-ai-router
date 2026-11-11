import type { ProviderDeviceFlow } from "./device-flow"

/**
 * The OAuth shapes a driver builds — token-endpoint calls, token sets, the authorization-code flow.
 * Split out of `types.ts` (the driver contract) by responsibility; `types.ts` re-exports every name.
 */

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
  readonly providerAccountId?: string
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
  readonly device?: ProviderDeviceFlow
  /** Zod at the boundary: a reshaped payload yields `null`, never a half-populated token set. */
  readTokens(
    body: unknown,
    context?: {
      readonly previousProviderAccountId?: string
      readonly previousAccessToken?: string
    },
  ): OAuthTokens | null
}

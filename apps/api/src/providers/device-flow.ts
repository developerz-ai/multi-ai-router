import type { OAuthTokenRequest } from "./types"

/**
 * A device-code sign-in, as a provider's OAuth flow declares it: the router asks the issuer for a
 * short user code, the operator types it at the issuer's verification page from any browser, and
 * the router polls until the issuer hands back an authorization code — the shape `codex login
 * --device-auth` uses on a headless host. No redirect has to land anywhere, so nothing has to be
 * pasted back.
 *
 * Declared on `ProviderOAuthFlow.device` (non-negotiable 12): the connect service and the console
 * read the declaration and never name a provider. Every member is a pure builder or reader; the
 * fetches, the polling cadence and the state binding belong to `services/accounts/connect/`.
 *
 * The issuer's handle for the attempt (`deviceAuthId` here) is a bearer secret for the poll and is
 * stored encrypted and never returned. The user code is not: it is what the operator types.
 */
export interface ProviderDeviceFlow {
  /** Where the operator enters the code. Public; shown in the console. */
  readonly verificationUrl: string
  /** The `redirect_uri` the issuer binds a device-issued code to, replayed at the code exchange. */
  readonly redirectUri: string
  /** Fallback poll cadence when the issuer states none it can be held to. */
  readonly defaultIntervalSeconds: number
  userCodeRequest(): OAuthTokenRequest
  /** Zod at the boundary: `null` for a reshaped answer, never half a code. */
  readUserCode(body: unknown): DeviceUserCode | null
  pollRequest(input: {
    readonly deviceAuthId: string
    readonly userCode: string
  }): OAuthTokenRequest
  /** What one poll answer means. Reads the status first; the body only on success. */
  readPoll(status: number, body: unknown): DevicePollResult
}

export interface DeviceUserCode {
  readonly deviceAuthId: string
  readonly userCode: string
  /** `null` when the issuer stated none (or zero); the caller falls back to the declared default. */
  readonly intervalSeconds: number | null
}

export type DevicePollResult =
  /** Not approved yet. Ask again after the interval. */
  | { readonly kind: "pending" }
  /** Approved: an authorization code plus the PKCE verifier the issuer minted for it. */
  | { readonly kind: "authorized"; readonly code: string; readonly codeVerifier: string }
  /** Anything else — denied, expired upstream, or a shape this build cannot read. Final. */
  | { readonly kind: "refused" }

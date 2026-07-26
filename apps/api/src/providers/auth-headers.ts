import type { ProviderCredential } from "./types"

/**
 * Upstream authentication headers. This file is the single place credential material is written
 * onto a request, and the one detail providers punish hardest when it is wrong.
 *
 * Anthropic-dialect rules (docs/idea/03-providers.md), by *whose* endpoint is being addressed:
 *
 * | Endpoint | Credential | Headers |
 * |---|---|---|
 * | Anthropic itself | API key | `x-api-key` + `anthropic-version` |
 * | Anthropic itself | OAuth / subscription token | `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` + `anthropic-version` |
 * | A compatible vendor (z.ai, Kimi, MiniMax) | vendor key | `Authorization: Bearer` + `anthropic-version` |
 *
 * Against Anthropic, an OAuth token on `x-api-key` does not work and a Bearer token without the
 * beta header does not either — converting between the two forms is a header change, not a key
 * swap. Against a compatible vendor neither applies: the key is just a key, presented the way
 * Claude Code presents `ANTHROPIC_AUTH_TOKEN`, and the OAuth beta must not be attached to it.
 */

/**
 * Provenance: Anthropic's Messages API version header, required on **every** Anthropic-dialect
 * request. Blast radius: omitting it is a `400` on every request to `anthropic-api`,
 * `anthropic-compatible`, and the Anthropic surfaces of z.ai / Kimi / MiniMax.
 */
export const ANTHROPIC_VERSION = "2023-06-01"

/**
 * Provenance: the beta opt-in that makes a genuine Anthropic OAuth/subscription token acceptable
 * on `Authorization: Bearer`. Blast radius: without it such a token is rejected as
 * unauthenticated — and attaching it to a *compatible vendor's* key claims a capability that
 * key does not have. The router never emits it for Claude subscriptions (those go through the
 * Agent SDK), but an operator-supplied Anthropic Account may carry such a token.
 */
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20"

/**
 * Which endpoint an Anthropic-dialect surface actually addresses.
 *
 * - `anthropic` — Anthropic's own API. The two credential forms take different headers.
 * - `vendor-bearer` — a compatible vendor's Anthropic-shaped endpoint. Verified first-hand from
 *   the operator's own configuration: z.ai and Kimi are driven with Claude Code's
 *   `ANTHROPIC_AUTH_TOKEN`, which is sent as `Authorization: Bearer`.
 */
export type AnthropicAuthForm = "anthropic" | "vendor-bearer"

/** The secret to present, whichever form the credential takes. */
function secretOf(credential: ProviderCredential): string {
  return credential.kind === "api-key" ? credential.apiKey : credential.accessToken
}

/**
 * A `null` credential is an Account of a provider that authenticates nobody (`authKind: "none"`),
 * holding nothing. Both builders below answer it the same way: **every mandated header still goes,
 * and only the auth header is left off**. Dropping `anthropic-version` along with the key would
 * turn "unauthenticated" into "malformed", which is a different failure and a worse message.
 */

export function anthropicAuthHeaders(
  credential: ProviderCredential | null,
  form: AnthropicAuthForm = "anthropic",
): Headers {
  const headers = new Headers({ "anthropic-version": ANTHROPIC_VERSION })
  if (credential === null) return headers

  if (form === "vendor-bearer") {
    // One correct header, not two hopeful ones: a vendor that rejects — or logs — an unexpected
    // `x-api-key` is a real risk, and no compatible vendor's key is an Anthropic OAuth token, so
    // the beta header stays off.
    headers.set("authorization", `Bearer ${secretOf(credential)}`)
    return headers
  }

  if (credential.kind === "oauth") {
    // Never `x-api-key` for this form: Anthropic rejects an OAuth token presented that way.
    headers.set("authorization", `Bearer ${credential.accessToken}`)
    headers.set("anthropic-beta", ANTHROPIC_OAUTH_BETA)
    return headers
  }

  headers.set("x-api-key", credential.apiKey)
  return headers
}

/** Every OpenAI-dialect provider, for both credential forms. */
export function bearerAuthHeaders(credential: ProviderCredential | null): Headers {
  if (credential === null) return new Headers()
  return new Headers({ authorization: `Bearer ${secretOf(credential)}` })
}

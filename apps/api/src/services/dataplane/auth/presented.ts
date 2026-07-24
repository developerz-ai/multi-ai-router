import { KeyRevokedError } from "@multi-ai-router/core"

/**
 * Reading the router key off a request. Pure: two header values in, one key or a refusal out.
 *
 * **Both header forms are first-class.** `Authorization: Bearer mar_live_…` is what the OpenAI
 * ecosystem sends (Codex CLI, Aider, the OpenAI SDKs); `x-api-key: mar_live_…` is what the
 * Anthropic ecosystem sends (Claude Code, the Anthropic SDKs). One key works in either, so the
 * operator never has to know which dialect a tool speaks
 * (docs/idea/04-api-keys-and-access.md#accepted-in-both-dialects).
 *
 * If both are present and **disagree**, the request is rejected rather than silently preferring
 * one: a client holding two different credentials does not know which one it is spending, and
 * picking for it would make the usage attribution a coin flip.
 */

const BEARER = /^Bearer\s+/i

const NO_KEY = "No router API key presented. Send Authorization: Bearer mar_live_… or x-api-key"
const DISAGREE =
  "Authorization and x-api-key carry different router keys. Send one, or send the same one twice"

/** The bearer credential, or null when the header is absent or is not a bearer at all. */
export function bearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) return null
  if (!BEARER.test(authorization)) return null
  const value = authorization.replace(BEARER, "").trim()
  return value.length === 0 ? null : value
}

/** @throws KeyRevokedError when no key is presented, or when two disagreeing keys are. */
export function presentedRouterKey(
  authorization: string | undefined,
  apiKey: string | undefined,
): string {
  const bearer = bearerToken(authorization)
  const direct = apiKey?.trim()
  const header = direct === undefined || direct.length === 0 ? null : direct

  if (bearer !== null && header !== null && bearer !== header) {
    throw new KeyRevokedError(DISAGREE)
  }

  const presented = bearer ?? header
  if (presented === null) throw new KeyRevokedError(NO_KEY)
  return presented
}

/**
 * Which dialect the caller's *credential style* implies. Used only where the path does not say —
 * `GET /v1/models` is one endpoint serving both ecosystems, and the header a client authenticated
 * with is the best available signal about which response shape it expects.
 */
export function credentialStyle(apiKey: string | undefined): "anthropic" | "openai" {
  const direct = apiKey?.trim()
  return direct !== undefined && direct.length > 0 ? "anthropic" : "openai"
}

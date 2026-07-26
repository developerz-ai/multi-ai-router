import { z } from "zod"

/**
 * The static provider registry's identifiers. A Provider is a *kind* of upstream, defined in
 * code — there is no provider table and no admin CRUD for it, so this list changes only when a
 * driver file is added under `providers/`.
 *
 * `anthropic-oauth` (Claude Max/Pro subscriptions) and `anthropic-api` (console API keys) are
 * deliberately separate ids: the first is served by the Agent-SDK driver and never sees a token
 * injected into an HTTP request, the second is an ordinary HTTP driver.
 */
export const ProviderId = z.enum([
  "anthropic-oauth",
  "anthropic-api",
  "openai-oauth",
  "openai-api",
  "openrouter",
  "zai",
  "kimi",
  "minimax",
  "gemini",
  "groq",
  "deepseek",
  "xai",
  "mistral",
  "together",
  "cerebras",
  "ollama",
  "openai-compatible",
  "anthropic-compatible",
])
export type ProviderId = z.infer<typeof ProviderId>

/**
 * How an Account authenticates to its Provider. `oauth` accounts have a refresh lifecycle,
 * `api-key` accounts are valid until revoked upstream. Claude subscription accounts are the
 * exception on both counts — the SDK owns their credentials inside `CLAUDE_CONFIG_DIR`.
 *
 * `none` is the local-endpoint case (`ollama`): the upstream authenticates nobody, so a credential
 * is **optional** rather than absent — supply one and it is presented as a bearer token, for the
 * same endpoint put behind a reverse proxy or a hosted surface that does check. It is the only
 * `AuthKind` under which an Account may hold no credential at all and still be routable; every
 * other provider's missing credential is a misconfiguration refused at write time.
 */
export const AuthKind = z.enum(["oauth", "api-key", "none"])
export type AuthKind = z.infer<typeof AuthKind>

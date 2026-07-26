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
  "openai-compatible",
  "anthropic-compatible",
])
export type ProviderId = z.infer<typeof ProviderId>

/**
 * How an Account authenticates to its Provider. `oauth` accounts have a refresh lifecycle,
 * `api-key` accounts are valid until revoked upstream. Claude subscription accounts are the
 * exception on both counts — the SDK owns their credentials inside `CLAUDE_CONFIG_DIR`.
 */
export const AuthKind = z.enum(["oauth", "api-key"])
export type AuthKind = z.infer<typeof AuthKind>

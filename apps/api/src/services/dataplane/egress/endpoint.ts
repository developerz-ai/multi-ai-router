import type { Dialect } from "@multi-ai-router/core"
import type { DriverAccount, ProviderDriver } from "../../../providers"

/**
 * Where a request in a given dialect goes on a given Account's endpoint.
 *
 * The driver owns the base URL (its pinned default, or the Account's override); the dialect owns
 * the path below it. Splitting them that way is what lets a self-hosted or regional endpoint work
 * with no new driver, and what lets z.ai expose an Anthropic surface and an OpenAI surface from
 * one provider file.
 *
 * The suffixes are the wire protocols' own, and the pinned base URLs already account for their
 * conventions: Anthropic's base carries no `/v1`, OpenAI's does. A compatible-provider endpoint an
 * operator supplies is expected to follow its dialect's convention for the same reason.
 */

const DIALECT_PATHS: Readonly<Record<Dialect, string>> = {
  anthropic: "/v1/messages",
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
}

/** The models listing each dialect exposes, for `GET /v1/models` pass-through use. */
const DIALECT_MODEL_PATHS: Readonly<Record<Dialect, string>> = {
  anthropic: "/v1/models",
  "openai-chat": "/models",
  "openai-responses": "/models",
}

/**
 * Anthropic's token-count endpoint, which has **no counterpart in either OpenAI dialect** — hence
 * a function of its own rather than a third row on the table above. A dialect with no entry there
 * would be a gap someone could index into and get `undefined`; a request this router cannot count
 * is refused by name in `egress/mode.ts`, before a URL is ever asked for.
 */
const ANTHROPIC_COUNT_TOKENS_PATH = "/v1/messages/count_tokens"

export function upstreamUrl(driver: ProviderDriver, account: DriverAccount, dialect: Dialect): URL {
  return join(driver.resolveBaseUrl(account), DIALECT_PATHS[dialect])
}

/**
 * Where `POST /v1/messages/count_tokens` goes on an Anthropic-dialect Account.
 *
 * Takes no dialect on purpose: only `anthropic` states this operation at all, so the caller having
 * chosen this function *is* the proof its candidate speaks it. An Anthropic-compatible vendor that
 * does not implement the endpoint answers its own `404`, which is relayed unchanged — the router
 * never substitutes a number of its own for a provider's answer.
 */
export function upstreamCountTokensUrl(driver: ProviderDriver, account: DriverAccount): URL {
  return join(driver.resolveBaseUrl(account), ANTHROPIC_COUNT_TOKENS_PATH)
}

/**
 * OpenAI's embeddings endpoint, which has **no counterpart in the Anthropic dialect** and — unlike
 * the chat primitives — no per-dialect variant either. `openai-chat` and `openai-responses` differ
 * only in how they word a *completion*, and an embeddings body words none, so one path serves both.
 * That is why this is a constant of its own rather than a third row on the table above.
 */
const OPENAI_EMBEDDINGS_PATH = "/embeddings"

/**
 * Where `POST /v1/embeddings` goes on an OpenAI-dialect Account.
 *
 * Takes no dialect for the opposite reason the token count does: both OpenAI surfaces state this
 * endpoint at the same place, so naming one would imply a distinction the wire does not make. An
 * OpenAI-compatible endpoint that serves chat but not embeddings answers its own `404`, which is
 * relayed unchanged — the router never substitutes a vector of its own for a provider's answer.
 */
export function upstreamEmbeddingsUrl(driver: ProviderDriver, account: DriverAccount): URL {
  return join(driver.resolveBaseUrl(account), OPENAI_EMBEDDINGS_PATH)
}

export function upstreamModelsUrl(
  driver: ProviderDriver,
  account: DriverAccount,
  dialect: Dialect,
): URL {
  return join(driver.resolveBaseUrl(account), DIALECT_MODEL_PATHS[dialect])
}

/** Appends a path below the base, preserving any path the base itself carries. */
function join(base: URL, suffix: string): URL {
  const url = new URL(base.toString())
  const prefix = url.pathname.replace(/\/+$/, "")
  url.pathname = `${prefix}${suffix}`
  return url
}

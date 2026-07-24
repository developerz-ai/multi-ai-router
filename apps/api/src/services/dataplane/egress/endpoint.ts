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

export function upstreamUrl(driver: ProviderDriver, account: DriverAccount, dialect: Dialect): URL {
  return join(driver.resolveBaseUrl(account), DIALECT_PATHS[dialect])
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

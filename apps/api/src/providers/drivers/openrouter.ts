import { createHttpDriver } from "../driver"
import { codeRule, messageRule } from "../failure/classify"

/**
 * `openrouter` — an aggregator, and a prepaid balance. Model ids are namespaced (`vendor/model`),
 * so an Account here almost always carries an alias map; the driver still never substitutes a
 * name on its own.
 */

/** Provenance: docs/idea/03-providers.md registry table. Blast radius: every `openrouter` request. */
const BASE_URL = "https://openrouter.ai/api/v1"

/**
 * Provenance: OpenRouter answers a spent balance with `402` and a message naming credits, and
 * echoes the numeric HTTP status back in `error.code` rather than a string identifier. Blast
 * radius: the wording rule is what catches a `402` proxied through with a different status.
 */
const INSUFFICIENT_CREDITS = /insufficient credits|requires more credits|add more using/i

export const openRouterDriver = createHttpDriver({
  id: "openrouter",
  surfaces: [{ dialect: "openai-chat", baseUrl: BASE_URL }],
  rules: [
    messageRule("credits-exhausted", "openrouter:insufficient-credits", INSUFFICIENT_CREDITS),
    codeRule("credits-exhausted", "openrouter:code-402", ["402"]),
    codeRule("rate-limited", "openrouter:code-429", ["429"]),
    codeRule("auth", "openrouter:code-401", ["401", "403"]),
  ],
})

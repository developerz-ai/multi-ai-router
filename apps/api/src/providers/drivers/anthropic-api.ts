import { createHttpDriver } from "../driver"
import { messageRule, typeRule } from "../failure/classify"

/**
 * `anthropic-api` — a pay-as-you-go console key. Ordinary HTTP, and **unrelated to the Claude
 * subscription path**: no subprocess, no `CLAUDE_CONFIG_DIR`, no `claude` CLI. Subscriptions go
 * through the Agent SDK and are not served by any driver in this directory
 * (docs/idea/11-anthropic-agent-sdk.md).
 */

/**
 * Provenance: docs/idea/03-providers.md registry table. Blast radius: every `anthropic-api`
 * request; an Account may override it for a proxy or a regional endpoint.
 */
const BASE_URL = "https://api.anthropic.com"

/**
 * Provenance: Anthropic answers a spent console balance with `400 invalid_request_error` whose
 * message is "Your credit balance is too low to access the Anthropic API…". Blast radius:
 * without this rule that response classifies as `invalid-request`, the account keeps being
 * selected, and every request fails identically until a human notices.
 */
const CREDIT_BALANCE_TOO_LOW = /credit balance is too low/i

export const anthropicApiDriver = createHttpDriver({
  id: "anthropic-api",
  surfaces: [{ dialect: "anthropic", baseUrl: BASE_URL }],
  rules: [
    messageRule("credits-exhausted", "anthropic:credit-balance-too-low", CREDIT_BALANCE_TOO_LOW),
    typeRule("credits-exhausted", "anthropic:billing_error", ["billing_error"]),
    typeRule("rate-limited", "anthropic:rate_limit_error", ["rate_limit_error"]),
    typeRule("server-error", "anthropic:overloaded_error", ["overloaded_error", "api_error"]),
  ],
})

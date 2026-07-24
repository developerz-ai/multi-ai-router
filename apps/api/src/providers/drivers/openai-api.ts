import { createHttpDriver } from "../driver"
import { codeRule, typeRule } from "../failure/classify"

/**
 * `openai-api` — a standard platform key. Two surfaces share one base URL: Chat Completions is
 * what the installed base sends, Responses is where new clients are going, and an Account picks
 * which one it speaks (docs/idea/06-protocol-translation.md).
 */

/** Provenance: docs/idea/03-providers.md registry table. Blast radius: every `openai-api` request. */
const BASE_URL = "https://api.openai.com/v1"

/**
 * Provenance: OpenAI returns **429** with `code: "insufficient_quota"` when the billing balance
 * is spent — the same status it uses for real rate limiting. Blast radius: reading the status
 * alone marks a dead account `cooling_down` and retries it on a timer forever, which is exactly
 * the conflation CLAUDE.md forbids.
 */
const CREDIT_CODES = ["insufficient_quota", "billing_hard_limit_reached", "account_deactivated"]

export const openAiApiDriver = createHttpDriver({
  id: "openai-api",
  surfaces: [
    { dialect: "openai-chat", baseUrl: BASE_URL },
    { dialect: "openai-responses", baseUrl: BASE_URL },
  ],
  rules: [
    codeRule("credits-exhausted", "openai:insufficient_quota", CREDIT_CODES),
    typeRule("credits-exhausted", "openai:insufficient_quota", CREDIT_CODES),
    codeRule("rate-limited", "openai:rate_limit_exceeded", ["rate_limit_exceeded"]),
    codeRule("auth", "openai:invalid_api_key", ["invalid_api_key", "invalid_organization"]),
  ],
})

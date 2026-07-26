import { createHttpDriver } from "../driver"
import { type ClassificationRule, typeRule } from "../failure/classify"
import { genericCreditsRule, throttleStatusRule } from "./compatible-rules"

/**
 * `together` — Together AI's OpenAI-compatible surface. Namespaced model ids
 * (`meta-llama/Llama-3.3-70B-Instruct-Turbo`), so an Account here almost always carries an alias
 * map; the driver still never substitutes a name on its own.
 *
 * The reason this is more than a base URL is one status: **Together's `403` is not a permission
 * refusal.** It is what the platform answers when the prompt plus `max_tokens` exceeds the model's
 * context length — a request-shaped mistake wearing the status this router otherwise reads as a
 * rejected credential. Left to the default, one oversized prompt would mark a perfectly good
 * account `auth`-failed and pull it out of the pool.
 */

/**
 * Provenance: Together's OpenAI-compatibility page and its OpenAPI `servers` entry. The older
 * `api.together.xyz` host still resolves and is an Account base-URL override, not a second constant
 * here. Blast radius: every `together` request.
 */
const BASE_URL = "https://api.together.ai/v1"

/**
 * Provenance: Together's error-code table — `403` is documented as "Input token count + max_tokens
 * parameter must be less than the context length of the model being queried", not as a permission
 * or scope failure. Blast radius: the shared default calls 403 `auth`, which is not retryable and
 * flags the credential; this rule keeps the blame on the request, where Together put it.
 */
const CONTEXT_LENGTH_STATUS = 403

const contextLengthRule: ClassificationRule = {
  kind: "invalid-request",
  signal: "together:context-length-403",
  when: (_facts, status) => status === CONTEXT_LENGTH_STATUS,
}

/**
 * Provenance: Together's rate-limit page — a request above the account's dynamic rate is refused
 * with one of these two error types. Blast radius: none on the verdict, which the `429` already
 * settles; they are recorded so an operator can tell a request-rate breach from a token-rate one.
 *
 * The distinction that *does* matter is on the other side: a failure **at or below** the dynamic
 * rate comes back as a `503`, meaning the platform is out of capacity rather than this account being
 * over its budget. The status default already calls that a `server-error`, which is the right
 * reading, and no rule here may take it away.
 */
const RATE_LIMIT_TYPES = ["dynamic_request_limited", "dynamic_token_limited"]

export const togetherDriver = createHttpDriver({
  id: "together",
  surfaces: [{ dialect: "openai-chat", baseUrl: BASE_URL }],
  rules: [
    contextLengthRule,
    typeRule("rate-limited", "together:dynamic-rate-limited", RATE_LIMIT_TYPES),
    // Together documents `402` for a monthly spending cap — which the status default already reads
    // as a dead balance — but says nothing about the status a zero prepaid balance returns, and it
    // is fully prepaid. The shared wording is the backstop, behind the throttle guard.
    throttleStatusRule,
    genericCreditsRule,
  ],
})

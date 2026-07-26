import { createHttpDriver } from "../driver"
import { type ClassificationRule, codeRule } from "../failure/classify"
import { genericCreditsRule, throttleStatusRule } from "./compatible-rules"

/**
 * `groq` — GroqCloud's OpenAI-compatible surface. Open-weight models on Groq's own hardware, under
 * Groq's own ids, so an Account here usually carries an alias map; the driver ships none and a name
 * it was not given passes through untouched.
 *
 * The reason this is more than a base URL: **Groq overloads OpenAI's `error.type` to name the limit
 * that was hit** — `tokens`, `requests` — rather than the kind of error. A `typeRule` here would be
 * reading a rate-limit dimension as an error vocabulary, so every rule below keys on `code`.
 */

/**
 * Provenance: Groq's OpenAI-compatibility base. The `/openai` segment is Groq's own and `/v1` is the
 * OpenAI convention below it, so `{base}/chat/completions` and `{base}/models` are exactly the URLs
 * the egress layer builds. Blast radius: every `groq` request.
 */
const BASE_URL = "https://api.groq.com/openai/v1"

/**
 * Provenance: Groq's spend-limit documentation — an organization past its configured spend limit is
 * refused with **HTTP 400 and `code: "blocked_api_access"`**. Blast radius: 400 is otherwise a
 * client mistake, so without this the account is never marked `exhausted`, stays selectable, and
 * fails every request handed to it while an operator debugs the request instead of the billing page.
 */
const BLOCKED_CODES = ["blocked_api_access"]

/** Provenance: Groq's 429 body. Recorded for the signal it names — a `429` classifies as a cooldown
 * on its status alone, and this is what says *which* limit Groq reported. */
const RATE_LIMIT_CODES = ["rate_limit_exceeded"]

/** Provenance: Groq's 401 body. Named so the recorded signal says which 401 this was. */
const AUTH_CODES = ["invalid_api_key"]

/**
 * Provenance: Groq's own status list carries **498, "Flex Tier Capacity Exceeded"** — a capacity
 * signal in the 4xx range. Blast radius: the shared default reads an unrecognized 4xx as an
 * `invalid-request`, which is *not* retryable, so a transient capacity refusal would fail the
 * request outright instead of moving to the next account.
 */
const FLEX_CAPACITY_STATUS = 498

const flexCapacityRule: ClassificationRule = {
  kind: "server-error",
  signal: "groq:flex-tier-capacity",
  when: (_facts, status) => status === FLEX_CAPACITY_STATUS,
}

export const groqDriver = createHttpDriver({
  id: "groq",
  surfaces: [{ dialect: "openai-chat", baseUrl: BASE_URL }],
  rules: [
    codeRule("credits-exhausted", "groq:blocked_api_access", BLOCKED_CODES),
    codeRule("rate-limited", "groq:rate_limit_exceeded", RATE_LIMIT_CODES),
    codeRule("auth", "groq:invalid_api_key", AUTH_CODES),
    flexCapacityRule,
    // Groq documents a spend *limit* but no status for a prepaid balance that simply reaches zero,
    // so the shared conservative wording is the backstop — behind the throttle guard, because Groq's
    // 429 message quotes the limit it hit and must never be read as a dead balance.
    throttleStatusRule,
    genericCreditsRule,
  ],
})

import { createHttpDriver } from "../driver"
import { type ClassificationRule, codeRule, messageRule, providerScoped } from "../failure/classify"
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

/**
 * Provenance: `413 "Request too large for model … on tokens per minute (TPM): Limit 8000, Requested
 * 33128"` (community.groq.com/t/1411): one request over the tier's per-minute allowance, so no wait
 * clears it. Another vendor takes the same prompt. Read ahead of the throttle code, which Groq may put
 * beside it. Blast radius: read as a throttle, every long prompt cooled a healthy key.
 */
const REQUEST_TOO_LARGE = /^request too large for model/i

/**
 * Provenance: Groq validates the body strictly and refuses a property it does not name with `400`,
 * `type: "invalid_request_error"`, no `code`: `property 'reasoning' is unsupported`
 * (github.com/musistudio/claude-code-router/issues/1458), inside a message as `'messages.2' : for
 * 'role:assistant' the following must be satisfied[('messages.2' : property 'reasoning' is
 * unsupported, did you mean 'role'?)]` (github.com/karthink/gptel/issues/774, `HTTP/2 400`).
 * The property name is quoted, so the wording read here is `property … is unsupported` with the
 * name removed. Prod 2026-11-27: an OpenRouter-native `reasoning` on `free` stopped the chain here
 * and the vendors behind Groq were never asked. Blast radius: a match moves the request to the
 * next vendor; a miss ends the chain as the client's mistake. A malformed body ("value must be a
 * string") carries other wording and still stops at Groq.
 */
const UNSUPPORTED_PROPERTY = /\bproperty\s+is unsupported\b/i

/**
 * Provenance: `model_decommissioned` (400) and `model_not_found` (404), console.groq.com/docs/changelog
 * (the batch error file "uses the same codes as the synchronous API"). Blast radius: without them a
 * retired id ends the chain as the client's mistake.
 */
const MODEL_CODES = ["model_not_found", "model_decommissioned"]

/**
 * Provenance: console.groq.com/docs/rate-limits states each limit per model, and the `429` names the
 * model it was for ("Rate limit reached for model …"). Blast radius: a `429` holds that model and the
 * key's others keep serving.
 */
const PER_MODEL_LIMITS = /./

export const groqDriver = createHttpDriver({
  id: "groq",
  surfaces: [{ dialect: "openai-chat", baseUrl: BASE_URL }],
  modelScopedRateLimits: PER_MODEL_LIMITS,
  rules: [
    providerScoped(
      messageRule("invalid-request", "groq:request-too-large", REQUEST_TOO_LARGE, {
        statuses: [413],
      }),
    ),
    providerScoped(
      messageRule("invalid-request", "groq:unsupported-field", UNSUPPORTED_PROPERTY, {
        statuses: [400],
        types: ["invalid_request_error"],
      }),
    ),
    codeRule("model-unsupported", "groq:model-code", MODEL_CODES),
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

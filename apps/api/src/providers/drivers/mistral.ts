import { createHttpDriver } from "../driver"
import { messageRule, typeRule } from "../failure/classify"
import { readFlatErrorFacts } from "../failure/error-body"
import { genericCreditsRule, throttleStatusRule } from "./compatible-rules"

/**
 * `mistral` — Mistral's OpenAI-compatible surface. Own model ids (`mistral-large-latest`,
 * `magistral-*`, `codestral-*`), so an Account here usually carries an alias map; the driver ships
 * none.
 *
 * The reason this is more than a base URL: **Mistral's error body has no `error` wrapper.** It is
 * `{object:"error", message, type, param, code}` at the top level, so the shared envelope reads
 * nothing at all from it and every Mistral failure would classify on its HTTP status alone.
 *
 * What this file does *not* do is read Mistral's `code`. Its own documentation shows a symbolic
 * value (`unknown_model`) while the wire sends numeric strings (`"3505"`), and captures of the same
 * condition disagree — so `type`, whose four categories Mistral does publish, is the only field
 * worth keying on.
 */

/**
 * Provenance: Mistral's OpenAI-migration guide names this as the base URL a stock OpenAI client is
 * pointed at, and its OpenAPI serves `/v1/chat/completions` from `https://api.mistral.ai`. Blast
 * radius: every `mistral` request.
 */
const BASE_URL = "https://api.mistral.ai/v1"

/**
 * Provenance: the four categories Mistral documents for `type` — `invalid_request_error`,
 * `authentication_error`, `rate_limit_error`, `server_error`. Only three are named here; the fourth
 * is what the status default already calls a client mistake. Blast radius: without them a body
 * relayed under a status that is not its own classifies on that status instead of on what Mistral
 * said.
 */
const RATE_LIMIT_TYPES = ["rate_limit_error"]
const AUTH_TYPES = ["authentication_error"]
const SERVER_TYPES = ["server_error"]

/**
 * Provenance: Mistral's capacity refusal — "Service tier capacity exceeded for this model." —
 * arrives as a 429 whose `type` and `code` differ between captures (`service_tier_capacity_exceeded`
 * in one, `invalid_request_error` with code `3505` in another). The message is the only stable part,
 * which is why it is matched here and the codes are not. Blast radius: it is capacity, never
 * billing, so reading it as a dead balance would take a healthy key out of the pool.
 */
const TIER_CAPACITY = /service tier capacity exceeded/i

export const mistralDriver = createHttpDriver({
  id: "mistral",
  surfaces: [{ dialect: "openai-chat", baseUrl: BASE_URL }],
  readFacts: readFlatErrorFacts,
  rules: [
    typeRule("rate-limited", "mistral:rate_limit_error", RATE_LIMIT_TYPES),
    messageRule("rate-limited", "mistral:service-tier-capacity", TIER_CAPACITY),
    typeRule("auth", "mistral:authentication_error", AUTH_TYPES),
    typeRule("server-error", "mistral:server_error", SERVER_TYPES),
    // Mistral documents no `402` and no status for the spend-suspended account its billing pages
    // describe, so the shared conservative wording is the only credit signal — behind the throttle
    // guard, because Mistral words a token-per-minute breach as a quota being exceeded.
    throttleStatusRule,
    genericCreditsRule,
  ],
})

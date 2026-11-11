import { createHttpDriver } from "../driver"
import { messageRule, typeRule } from "../failure/classify"
import type { ProviderDriver } from "../types"

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
 * Provenance: Anthropic's prompt-caching docs — a top-level `cache_control: {type: "ephemeral"}` on
 * a Messages request is automatic caching, GA with no beta header, counted toward the cap of four
 * breakpoints. Blast radius: every OpenAI-wire request translated to an `anthropic-api` account that
 * states no marker of its own; without it that request caches nothing and an agent loop re-bills its
 * whole prefix every turn (a 1.25x write on turn 1, repaid from turn 2).
 */
const AUTOMATIC_CACHE = true

/**
 * Provenance: Anthropic answers a spent console balance with `400 invalid_request_error` whose
 * message is "Your credit balance is too low to access the Anthropic API…". Blast radius: without
 * this rule that response classifies as `invalid-request`, the account keeps being selected, and
 * every request fails identically until a human notices.
 *
 * Anchored at the start, on that status and type only: Anthropic's `404 not_found_error` echoes the
 * requested name as `model: <name>`, and a client naming its model "credit balance is too low" must
 * not park the key `exhausted` (sweep 101, 04.1).
 */
const CREDIT_BALANCE_TOO_LOW = /^your credit balance is too low/i

const driver = createHttpDriver({
  id: "anthropic-api",
  surfaces: [{ dialect: "anthropic", baseUrl: BASE_URL, cacheControl: AUTOMATIC_CACHE }],
  rules: [
    messageRule("credits-exhausted", "anthropic:credit-balance-too-low", CREDIT_BALANCE_TOO_LOW, {
      statuses: [400],
      types: ["invalid_request_error"],
    }),
    typeRule("credits-exhausted", "anthropic:billing_error", ["billing_error"]),
    typeRule("rate-limited", "anthropic:rate_limit_error", ["rate_limit_error"]),
    // Anthropic's own busy backend (`529`): retried with backoff, never held against the key.
    typeRule("overloaded", "anthropic:overloaded_error", ["overloaded_error"]),
    typeRule("server-error", "anthropic:api_error", ["api_error"]),
  ],
})

export const anthropicApiDriver: ProviderDriver = {
  ...driver,
  // The idle keepalive/probe's one minimal turn: the cheapest current model this provider serves.
  // Provenance: carried from `scheduler/tasks/idle-account-probe.ts` IDLE_PROBE_MODELS (sweep 101).
  idleProbeModel: "claude-haiku-4-5-20251001",
}

import { createHttpDriver } from "../driver"
import { codeRule, messageRule, onStatus, withResetEstimate } from "../failure/classify"

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

/**
 * A per-key spend cap the operator set on the OpenRouter key, announced as
 * `403 "Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/…"`.
 *
 * Provenance: this router's production log, 2026-10-04 21:54Z — read as `http-status:403` → `auth`,
 * so a healthy key sat in "credential rejected" on the auth re-test cadence. It is not a credential
 * fault: the key is valid and its *spend* is capped. A `total` cap (or one naming no window) lifts
 * only when a human raises it, so it is `credits-exhausted` (402, never retried on a timer). A key
 * whose cap resets `daily` / `weekly` / `monthly` (OpenRouter's `limit_reset`, at 00:00 UTC) reopens
 * on a clock, so it is `rate-limited` with an estimated re-test — the reset instant is not in the
 * body, and the window wording is inferred from the `(total limit)` form, not yet observed.
 *
 * Blast radius: every OpenRouter 403 naming a key limit. Window first, so a resetting cap is never
 * parked as permanent.
 */
const KEY_LIMIT_WINDOW = /key limit exceeded\s*\((?:daily|weekly|monthly) limit\)/i
const KEY_LIMIT = /key limit exceeded/i

/**
 * Re-test cadence for a resetting key cap: the earliest a daily window can reopen is hours away,
 * and one probe an hour is all a still-capped key costs. Provenance: chosen 2026-10-04. Blast
 * radius: how soon a key whose daily cap reset is found serving again.
 */
const KEY_LIMIT_RETEST_SECONDS = 60 * 60

export const openRouterDriver = createHttpDriver({
  id: "openrouter",
  surfaces: [{ dialect: "openai-chat", baseUrl: BASE_URL }],
  rules: [
    withResetEstimate(
      messageRule("rate-limited", "openrouter:key-limit-window", KEY_LIMIT_WINDOW),
      KEY_LIMIT_RETEST_SECONDS,
    ),
    messageRule("credits-exhausted", "openrouter:key-limit", KEY_LIMIT),
    onStatus(
      [403],
      messageRule(
        "invalid-request",
        "openrouter:moderation",
        /moderation|flagged.*content|content.*flagged/i,
      ),
    ),
    {
      kind: "server-error",
      signal: "openrouter:http-408",
      when: (_facts, status) => status === 408,
    },
    messageRule("credits-exhausted", "openrouter:insufficient-credits", INSUFFICIENT_CREDITS),
    codeRule("credits-exhausted", "openrouter:code-402", ["402"]),
    codeRule("rate-limited", "openrouter:code-429", ["429"]),
    codeRule("auth", "openrouter:code-401", ["401"]),
  ],
})

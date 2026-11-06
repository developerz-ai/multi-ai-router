import type { ClassificationRule } from "../failure/classify"
import type { UpstreamErrorFacts } from "../types"

/**
 * The two rules a driver reaches for when it cannot name the vendor's own vocabulary — the generic
 * escape hatches by definition, and a pinned vendor whose docs simply do not say.
 *
 * They are a **pair with an order**: `throttleStatusRule` must be listed before `genericCreditsRule`
 * wherever both are used, because a throttle whose message happens to name a quota would otherwise
 * read as a dead balance and park a healthy account at `402` that no clock revives — the same trap
 * `drivers/gemini.ts` documents at length.
 */

/**
 * The codes OpenAI publishes for a spent balance, which OpenAI-shaped gateways pass through
 * verbatim. Provenance: OpenAI's error-code docs; `openai-api.ts` reads the same pair. Blast radius:
 * a code here parks the account `exhausted` on any error status, ahead of every wording rule and of
 * {@link throttleStatusRule} — before this, a `429` carrying `insufficient_quota` read as a throttle
 * with no reset and cooled for one second, then was retried on a timer forever.
 */
const CREDIT_CODES: readonly string[] = ["insufficient_quota", "billing_hard_limit_reached"]

function namesCreditCode(facts: UpstreamErrorFacts): boolean {
  return [facts.code, facts.type].some(
    (value) => value !== undefined && CREDIT_CODES.includes(value),
  )
}

/**
 * The wording backstop. Guessing at an unknown vendor's vocabulary produces confident
 * misclassifications, so it matches only a dead prepaid balance, worded the way most OpenAI- and
 * Anthropic-shaped gateways word it — and it is the weakest evidence there is, so it yields:
 *
 * - **to a code**: a published credits code decides first, on any error status;
 * - **to the status**: only a `4xx` — a `5xx` naming a quota is the server's trouble — and on a `429`
 *   only balance words, because "quota exceeded" on the throttle status is how per-minute limits
 *   are worded (Gemini, most gateways) and parked a healthy account `exhausted` for good;
 * - **to a stated reset**, for quota words only: a response naming when its limit lifts is
 *   describing a clock. Balance words name no window, and limiter headers ride every response —
 *   a drained balance often arrives beside `x-ratelimit-remaining: 0` — so they stand.
 *
 * Guarded by an error status, so a completion that happens to contain the word "quota" is never
 * read as a billing stop. The signal it records names the *rule*, not a provider, which is the
 * honest label: a verdict reached from phrasing rather than from a vocabulary the vendor publishes.
 */
const BALANCE_WORDING = /insufficient (?:credits?|balance)|out of credits|balance is insufficient/i
const QUOTA_WORDING = /insufficient quota|quota (?:exceeded|exhausted)/i

/** Balance words name no window, so they stand beside a reset; quota words may name one. */
function wordsDeadBalance(message: string, status: number, statedReset: boolean): boolean {
  return (
    BALANCE_WORDING.test(message) || (status !== 429 && !statedReset && QUOTA_WORDING.test(message))
  )
}

export const genericCreditsRule: ClassificationRule = {
  kind: "credits-exhausted",
  signal: "compatible:out-of-credits-wording",
  when: (facts, status, stated) =>
    status >= 400 &&
    (namesCreditCode(facts) ||
      (status < 500 && wordsDeadBalance(facts.message ?? "", status, stated.reset))),
}

/**
 * A `429` is clock-recoverable, whatever the body says — except a published credits code, which
 * {@link genericCreditsRule} reads first.
 *
 * Not for the escape hatches: behind one of those may sit an OpenAI-shaped endpoint, and OpenAI
 * announces a *spent balance* as a 429 (`insufficient_quota`) — so there, the wording is the only
 * thing that can tell the two apart and this guard would throw it away. It is for a pinned vendor
 * that documents 429 as rate limiting and documents no billing state on it.
 */
export const throttleStatusRule: ClassificationRule = {
  kind: "rate-limited",
  signal: "vendor:http-429",
  when: (facts, status) => status === 429 && !namesCreditCode(facts),
}

/** Sanitized monthly quota fixture; a missing/ambiguous date stays an unknown temporary reset. */
export const reportedQuotaResetRule: ClassificationRule = {
  kind: "rate-limited",
  signal: "compatible:reported-body-reset",
  when: (facts, status) =>
    status === 429 &&
    /quota (?:has been )?exhausted\. The quota will reset at \d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\./i.test(
      facts.message ?? "",
    ),
}

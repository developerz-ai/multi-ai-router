import type { ClassificationRule } from "../failure/classify"

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
 * The one wording rule. Guessing at an unknown vendor's error vocabulary would produce confident
 * misclassifications, so this is deliberately the only phrasing it matches: a dead prepaid balance,
 * worded the way most OpenAI- and Anthropic-shaped gateways word it.
 *
 * Guarded by an error status, so a completion that happens to contain the word "quota" is never
 * read as a billing stop. The signal it records names the *rule*, not a provider, which is the
 * honest label: a verdict reached from phrasing rather than from a vocabulary the vendor publishes.
 */
const OUT_OF_CREDITS =
  /insufficient (?:quota|credits?|balance)|out of credits|quota (?:exceeded|exhausted)|balance is insufficient/i

export const genericCreditsRule: ClassificationRule = {
  kind: "credits-exhausted",
  signal: "compatible:out-of-credits-wording",
  when: (facts, status) => status >= 400 && OUT_OF_CREDITS.test(facts.message ?? ""),
}

/**
 * A `429` is clock-recoverable, whatever the body says.
 *
 * Not for the escape hatches: behind one of those may sit an OpenAI-shaped endpoint, and OpenAI
 * announces a *spent balance* as a 429 (`insufficient_quota`) — so there, the wording is the only
 * thing that can tell the two apart and this guard would throw it away. It is for a pinned vendor
 * that documents 429 as rate limiting and documents no billing state on it.
 */
export const throttleStatusRule: ClassificationRule = {
  kind: "rate-limited",
  signal: "vendor:http-429",
  when: (_facts, status) => status === 429,
}

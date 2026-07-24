import type { ClassificationRule } from "../failure/classify"

/**
 * The one classification rule the generic escape hatches share. Guessing at an unknown vendor's
 * error vocabulary would produce confident misclassifications, so this is deliberately the only
 * wording either of them matches: a dead prepaid balance, phrased the way most OpenAI- and
 * Anthropic-shaped gateways phrase it.
 *
 * Guarded by an error status, so a completion that happens to contain the word "quota" is never
 * read as a billing stop.
 */
const OUT_OF_CREDITS =
  /insufficient (?:quota|credits?|balance)|out of credits|quota (?:exceeded|exhausted)|balance is insufficient/i

export const genericCreditsRule: ClassificationRule = {
  kind: "credits-exhausted",
  signal: "compatible:out-of-credits-wording",
  when: (facts, status) => status >= 400 && OUT_OF_CREDITS.test(facts.message ?? ""),
}

import { SDK_ACCOUNT_FAILURE_RULES } from "./failure-rules-account"
import { SDK_QUOTA_FAILURE_RULES } from "./failure-rules-quota"
import { SDK_REQUEST_FAILURE_RULES } from "./failure-rules-request"
import type { SdkRule } from "./failure-rules-vocabulary"

/**
 * The public surface of the Agent-SDK failure classification (docs/idea/11-anthropic-agent-sdk.md
 * §9): what the `claude` CLI says, in order, most specific first. `errors.ts` walks it; this module
 * is only the façade, kept apart so the table can grow without the walker growing with it.
 *
 * The table itself is split by responsibility, and the rows are contiguous — the split is by *what
 * a rule is about*, never by theme across a boundary:
 *
 * - `failure-rules-vocabulary.ts` — the shared shapes and matchers: what a failure is matched
 *   against (`Haystack`), how a rule is shaped (`SdkRule`), and the router-authored client sentences.
 * - `failure-rules-request.ts` — the rows about the request: an unsatisfiable `tool_choice`, an
 *   oversized prompt, a session the CLI no longer holds, a CLI too old for the model asked for.
 * - `failure-rules-quota.ts` — the rows about quota: a model this plan cannot reach, a dead credit
 *   balance, Extra Usage spent, a spent plan window, a bare rate limit.
 * - `failure-rules-account.ts` — the rows about the account: a contended credential refresh, a dead
 *   credential, a crashed subprocess, an overloaded upstream — plus the honest fallback.
 *
 * Provenance: every phrase is the CLI's own wording — recorded from the 0.3.220, 0.3.261 and
 * 0.3.286 binaries' string tables, from Meridian's production matching, and from this router's own
 * production logs. Blast radius: a phrase the CLI rewords stops matching and its class degrades to
 * `unknown` — a `502` and a failover, never a silent mislabel. That is why the fallback is honest
 * rather than convenient, and why a reworded rate limit must never quietly become an auth failure.
 *
 * Two kinds of evidence, and phrases go first: the SDK's structured `api_error_status` is a fact
 * about the HTTP answer, but Anthropic answers "credit balance is too low" with a `400`, so a
 * status read before the sentence would call a dead balance a bad request. The status is the
 * fallback for a sentence nobody has recorded yet — strictly better than `unknown`, never better
 * than a named phrase.
 */

/**
 * The whole table, in the order the classifier reads it: request rows, then quota rows, then
 * account rows. The order is load-bearing — a named phrase beats a bare status token every time,
 * and several rows are ordered ahead of a sibling whose wording they contain.
 */
export const SDK_FAILURE_RULES: readonly SdkRule[] = [
  ...SDK_REQUEST_FAILURE_RULES,
  ...SDK_QUOTA_FAILURE_RULES,
  ...SDK_ACCOUNT_FAILURE_RULES,
]

export { UNCLASSIFIED_SDK_RULE } from "./failure-rules-account"
export type { Haystack, Matcher, SdkRule } from "./failure-rules-vocabulary"
export {
  any,
  apiStatus,
  CREDITS_SPENT,
  EXTRA_USAGE_GATED,
  NEEDS_REAUTH,
  statusToken,
  WINDOW_SPENT,
} from "./failure-rules-vocabulary"

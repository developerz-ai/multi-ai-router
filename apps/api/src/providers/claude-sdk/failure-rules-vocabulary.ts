import type { UpstreamFailureKind } from "../types"

/**
 * The vocabulary of the Agent-SDK failure classification (docs/idea/11-anthropic-agent-sdk.md §9):
 * what a failure is *matched* against, how a rule is shaped, and the router-authored sentences a
 * client may see. Kept apart from the table itself so the rows can be split by responsibility
 * without dragging the shared shapes along with them.
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

/** Lowercased once, matched many times. */
export interface Haystack {
  readonly message: string
  /** Message plus the stderr tail. Phrases may match either half. */
  readonly all: string
  /** The SDK's structured status for a failed `result`, when it reported one. */
  readonly apiErrorStatus: number | null
  /** The SDK's own reason the turn stopped, when it named one. */
  readonly terminalReason: string | null
}

export interface SdkRule {
  readonly kind: UpstreamFailureKind
  /** Recorded on the classification so a misclassification is traceable to its trigger. */
  readonly signal: string
  /** What this failure would be answered with if no account could serve the request. */
  readonly status: number
  readonly clientMessage: string
  readonly match: (text: Haystack) => boolean
  /** Copied onto the classification: see `FailureClassification.requestAttributable`. */
  readonly requestAttributable?: true
}

export type Matcher = (text: Haystack) => boolean

/** Any of these phrases, in the message or the stderr tail. */
export function phrase(...needles: readonly string[]): Matcher {
  return (text) => needles.some((needle) => text.all.includes(needle))
}

/** Any of these phrases, in the **message** only — for wording too common to trust off stderr. */
export function messagePhrase(...needles: readonly string[]): Matcher {
  return (text) => needles.some((needle) => text.message.includes(needle))
}

/** All of these phrases, in either half — for a class no single phrase identifies. */
export function all(...needles: readonly string[]): Matcher {
  return (text) => needles.every((needle) => text.all.includes(needle))
}

export function pattern(regex: RegExp): Matcher {
  return (text) => regex.test(text.all)
}

export function any(...matchers: readonly Matcher[]): Matcher {
  return (text) => matchers.some((matcher) => matcher(text))
}

/**
 * A bare status number, as a whole word, in the **message** only — see the module note in
 * `errors.ts`. `(?!:\d)` refuses a `file.js:401:15` stack frame, whose column would otherwise read
 * as a status (Meridian hit exactly that).
 */
export function statusToken(status: number): Matcher {
  const regex = new RegExp(`\\b${status}\\b(?!:\\d)`)
  return (text) => regex.test(text.message)
}

/** The SDK's structured status — a fact, read only where a sentence did not already decide. */
export function apiStatus(...statuses: readonly number[]): Matcher {
  return (text) => text.apiErrorStatus !== null && statuses.includes(text.apiErrorStatus)
}

export const WINDOW_SPENT = "the account's Claude subscription window is spent"
/**
 * Extra Usage, and the one client-facing sentence about it. Router-authored like every other
 * `clientMessage`, and deliberately says nothing about *which* account, how many were tried, or how
 * long any of them is cooling down — the rotation is the router's business, and a caller only ever
 * hears this when nothing in the pool could serve. What it does name is the remedy, because that is
 * the one thing a caller (or the operator reading their report) can act on.
 */
export const EXTRA_USAGE_GATED =
  "no Claude subscription capacity is available right now — this request was metered against Extra Usage, which is spent; add more at claude.ai/settings/usage"
export const NEEDS_REAUTH = "the account's Claude subscription needs re-authenticating"
export const CREDITS_SPENT =
  "the account's credit balance is spent — it needs a top-up, not a retry"

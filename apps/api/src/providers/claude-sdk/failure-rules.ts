import type { UpstreamFailureKind } from "../types"

/**
 * The classification table for Agent-SDK failures (docs/idea/11-anthropic-agent-sdk.md §9): what
 * the `claude` CLI says, in order, most specific first. `errors.ts` walks it; this file is only
 * the vocabulary, kept apart so the table can grow without the walker growing with it.
 *
 * Provenance: every phrase is the CLI's own wording — recorded from the 0.3.220 and 0.3.261
 * binaries' string tables, from Meridian's production matching, and from this router's own
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
}

export type Matcher = (text: Haystack) => boolean

/** Any of these phrases, in the message or the stderr tail. */
function phrase(...needles: readonly string[]): Matcher {
  return (text) => needles.some((needle) => text.all.includes(needle))
}

/** Any of these phrases, in the **message** only — for wording too common to trust off stderr. */
function messagePhrase(...needles: readonly string[]): Matcher {
  return (text) => needles.some((needle) => text.message.includes(needle))
}

/** All of these phrases, in either half — for a class no single phrase identifies. */
function all(...needles: readonly string[]): Matcher {
  return (text) => needles.every((needle) => text.all.includes(needle))
}

function pattern(regex: RegExp): Matcher {
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

export const SDK_FAILURE_RULES: readonly SdkRule[] = [
  {
    // The rules that are **not** CLI prose: every sentence here is one of this router's own throws
    // (`request.ts`, `tools/register.ts`, `invoker.ts`). Provenance is our source rather than the
    // binary's; a reworded throw site degrades to `unknown`. `invalid-request`, because all three
    // are client request-shape bugs Anthropic's own API answers `400`: no failover, no breaker
    // strike — `failoverKind` maps the kind to `client-error`, which `breaker.ts` exempts.
    kind: "invalid-request",
    signal: "claude-sdk:tool-choice-unsatisfiable",
    status: 400,
    clientMessage:
      "the request's tool_choice demands a tool call its own declared tools do not provide",
    match: phrase(
      "which is not among the declared tools",
      "which requires a tool call, but the request declared no tools",
      "is recognized but its payload is one this router cannot read",
    ),
  },
  {
    // The turn *ran* and answered free-form text where a tool call was forced: an upstream that
    // did not comply — `server-error`, retryable because the next account's model may honour it.
    kind: "server-error",
    signal: "claude-sdk:forced-tool-unmet",
    status: 502,
    clientMessage: "the turn ended without the tool call the request's tool_choice forced",
    match: phrase("but the turn completed without one"),
  },
  {
    // Both the session and the rewind point: a fork whose `resumeSessionAt` uuid the transcript
    // no longer holds ("No message found with message.uuid of:", CLI 2.1.261) fails identically
    // on every retry, so it is the same class as a vanished session — evict the binding, replay
    // once in place. Before it was named here it fell to `unknown`, which is not retryable: the
    // request failed outright and the binding that caused it survived to fail the next one.
    kind: "stale-session",
    signal: "claude-sdk:session-not-found",
    status: 502,
    clientMessage: "the Claude Agent SDK session this conversation resumed no longer exists",
    match: phrase("no conversation found with session id", "no message found with message.uuid"),
  },
  {
    kind: "busy-session",
    signal: "claude-sdk:session-busy",
    status: 503,
    clientMessage: "the Claude Agent SDK session this conversation resumed is still running",
    match: phrase("is currently running as a background agent"),
  },
  {
    // Waiting does not fix an oversized prompt: an identical retry burns a whole upstream turn on
    // every account in the pool to fail identically, striking each breaker on the way. `400` says
    // the request itself is the problem. Wordings: the CLI's own "Prompt is too long" (2.1.261
    // string table), the API's fuller "prompt is too long: N tokens > M maximum", its
    // `max_tokens` phrasing, the OpenAI-compatible code — and, when the SDK states it outright,
    // its `terminal_reason: "prompt_too_long"`.
    kind: "invalid-request",
    signal: "claude-sdk:prompt-too-long",
    status: 400,
    clientMessage:
      "the prompt exceeds the model's context window; an identical retry fails the same way",
    match: any(
      phrase("prompt is too long", "context_length_exceeded", "exceed context limit"),
      (text) => text.terminalReason === "prompt_too_long",
    ),
  },
  {
    // The router's own `claude` is older than the model asked for — the API answers `400 Claude
    // Code 2.1.198 does not support this model; version 2.1.251 or newer is required` (Meridian,
    // observed live). Every account behind this router shares that binary, so a failover would
    // spend the whole pool and trip every breaker on a fact about the image. `400` to the client,
    // no account struck; the fix is a router upgrade and the sentence says so.
    kind: "invalid-request",
    signal: "claude-sdk:cli-too-old-for-model",
    status: 400,
    clientMessage:
      "this router's claude CLI is older than the requested model requires — the router image needs upgrading, not the request",
    match: pattern(/claude code(?: \d[\w.+-]*)? does not support this model/),
  },
  {
    // The one condition non-negotiable 7 forbids conflating with a rate limit: the underlying
    // account is billing-dead, and no clock revives it. `402`, `exhausted`, never timer-retried.
    // Provenance: the CLI's error constant "Credit balance is too low" (0.3.220 and 2.1.261);
    // "Your organization is out of usage credits. Contact your admin to add more." and "Your
    // group's usage limit is set to $0" (2.1.261, the credits-era caps an admin must raise —
    // Meridian #909/#929). Matched as full phrases, because a wrong match here parks a healthy
    // account at `402` until a human intervenes — the one misclassification worse than `unknown`.
    kind: "credits-exhausted",
    signal: "claude-sdk:credit-balance",
    status: 402,
    clientMessage: CREDITS_SPENT,
    match: any(
      phrase("credit balance is too low", "organization is out of usage credits"),
      pattern(/usage limit is set to \$\d/),
    ),
  },
  {
    // The sentence Anthropic answers a *harness-fingerprinted* request with — `400 Third-party apps
    // now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and
    // keep going.` (production, 2026-09-05, through opencode). It is a `400`, and before this row it
    // fell through every phrase to the bare `apiStatus(400)` rule and read as `invalid-request`: not
    // retryable, so the planner never tried another account, and the client was told its request was
    // malformed when the request was fine and the *account* had no Extra Usage left.
    //
    // `rate-limited` is the honest class. Nothing about the request is wrong; this account cannot
    // serve it and a clock will change that, which is exactly `cooling_down` (non-negotiable 7) —
    // never `credits-exhausted`, which would park a healthy subscription at `402` until a human
    // intervened. Retryable, so the chain rotates to the next account, and the breaker cools this
    // one down so the pool is not burned on it again on the very next request.
    //
    // Ordered ahead of `claude-sdk:overage-required` because it is the more specific sentence, and
    // ahead of every bare status token by construction (see the module note in `errors.ts`). The
    // real fix is upstream of classification — `scrub.ts` removes the fingerprint that provokes it —
    // and this row is what keeps the pool alive for the prompts it does not catch.
    kind: "rate-limited",
    signal: "claude-sdk:extra-usage-gated",
    status: 429,
    clientMessage: EXTRA_USAGE_GATED,
    match: any(
      phrase("third-party apps now draw from your extra usage"),
      all("extra usage", "claude.ai/settings/usage"),
    ),
  },
  {
    // Cooling down, not `credits-exhausted`: the request asked for a variant the account's plan
    // does not cover right now, and the included window it falls back to refills on a clock. The
    // long-context phrases are the CLI's own wording (0.3.220 extended-context detector); "out of
    // extra usage" is Meridian's live-observed variant; "you're out of usage credits" is the
    // credits-era spelling of the same condition (2.1.261 — the *member's* top-up is spent, the
    // included window still refills, Meridian #890 reads it the same way).
    kind: "rate-limited",
    signal: "claude-sdk:overage-required",
    status: 429,
    clientMessage: "the account's plan does not cover the extended-context variant of this model",
    match: (text) =>
      all("extra usage", "1m")(text) ||
      phrase(
        "extra usage is required for long context",
        "usage credits are required for long context",
        "out of extra usage",
        "out of usage credits",
      )(text),
  },
  {
    kind: "rate-limited",
    signal: "claude-sdk:rate-limited",
    status: 429,
    clientMessage: WINDOW_SPENT,
    match: phrase("usage limit reached", "rate limit"),
  },
  {
    // The wording a *plan window* actually uses. Recorded verbatim from a Max subscription whose
    // weekly window was spent: "You've hit your weekly limit · resets Jul 30, 11pm (UTC)". The
    // 2.1.261 string table adds "You've hit your monthly spend limit", "You've hit your fast
    // limit", "You've reached your Fable limit" and "you have reached your weekly usage limit" —
    // all the same family: a named window with its own reset, which is what `rate-limited`
    // means. `all("hit your", "limit")` covers the first shape without reaching further than the
    // evidence; the "reached your" shape is bounded to one-to-three qualifier words so that a
    // sentence about some other configured limit (Meridian #909's "reached your configured …")
    // cannot read as quota.
    kind: "rate-limited",
    signal: "claude-sdk:plan-window-spent",
    status: 429,
    clientMessage: WINDOW_SPENT,
    match: any(
      all("hit your", "limit"),
      pattern(/you(?:'|’)?(?:ve| have) reached your (?:[\w'’.-]+ ){1,3}limit/),
    ),
  },
  {
    // Every spelling the CLI has for a credential that no longer works, from the 0.3.220 and
    // 2.1.261 string tables: "OAuth token has expired", "Failed to authenticate: OAuth session
    // expired and could not be refreshed" (production, 2026-09-05 — the refresh token's 30-day
    // hard expiry), "Not logged in · Please run /login", "API Error: 401 Invalid API key · Please
    // run /login", "Session expired. Please run /login". `authentication failed` is read from the
    // message only: the same words describe an MCP server's own trouble on stderr.
    kind: "auth",
    signal: "claude-sdk:credential-expired",
    status: 401,
    clientMessage: NEEDS_REAUTH,
    match: any(
      phrase(
        "oauth token has expired",
        "oauth session expired",
        "could not be refreshed",
        "not logged in",
        "failed to authenticate",
        "please run /login",
        "invalid api key",
        "invalid authentication",
        "authentication_error",
      ),
      messagePhrase("authentication failed"),
    ),
  },
  {
    // Ahead of the bare tokens on purpose: a crash prints whatever the subprocess last said, and
    // an exit is a fact about the process rather than an opinion about the credential.
    kind: "subprocess-crash",
    signal: "claude-sdk:subprocess-exit",
    status: 502,
    clientMessage: "the Claude Agent SDK subprocess exited before answering",
    match: phrase("exited with code", "process exited"),
  },
  {
    // Anthropic's own overload answer (`529`, and the `503` beside it), which the SDK reports as
    // `api_error_status` once it has retried and given up. Retryable on the next account — an
    // overload is about the upstream, not this credential — and answered with Anthropic's code
    // so a coding agent's retry policy reads it as the transient it is. Before this rule it fell
    // to `unknown`, which is *not* retryable: one overloaded answer failed the request outright
    // with four healthy accounts unasked.
    kind: "server-error",
    signal: "claude-sdk:overloaded",
    status: 529,
    clientMessage: "the upstream is overloaded; retry shortly",
    match: any(phrase("overloaded"), statusToken(529), apiStatus(503, 529)),
  },
]

/**
 * Nothing matched. `502` and a failover, because an unreadable failure is still one account failing
 * and the next one may well serve — the one thing it must not do is name a class it cannot support.
 */
export const UNCLASSIFIED_SDK_RULE: SdkRule = {
  kind: "unknown",
  signal: "claude-sdk:unclassified",
  status: 502,
  clientMessage: "the Claude Agent SDK failed for a reason this router does not recognize",
  match: () => true,
}

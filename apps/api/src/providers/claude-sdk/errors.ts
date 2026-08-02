import { isRetryableFailureKind } from "../failure/classify"
import type { FailureClassification, UpstreamFailureKind } from "../types"

/**
 * What an Agent-SDK failure *is* (docs/idea/11-anthropic-agent-sdk.md §9).
 *
 * `ProviderDriver.classifyFailure` reads a status line and a provider-shaped body. Neither exists
 * here: `query()` throws, and what it throws is prose — the CLI's own sentence, sometimes with the
 * subprocess's stderr behind it. So this is substring matching, which is exactly as brittle as it
 * sounds, and the three mitigations are structural rather than hopeful:
 *
 * - **Ordered, most specific first.** A named phrase beats a bare status token every time, so an
 *   incidental number inside a longer message cannot outrank the sentence that explains it.
 * - **A bare status token is read from the message only, never from the stderr tail.** Meridian maps
 *   a generic `exit 1` to `401` on a heuristic and so reports every crash as an auth failure — which
 *   marks a perfectly good Account `needs_reauth` and drops it from routing until a human logs in
 *   again. A `401` somewhere in a megabyte of stderr is not evidence about *this* failure.
 * - **The SDK's own words never reach a client.** Every class carries a router-authored sentence;
 *   the raw text rides `FailureClassification.message`, whose contract already says it is for logs.
 *
 * Classification is where this module stops. It never refreshes a credential — the SDK owns the
 * token and an expired one is `needs_reauth`, not a retry (§3) — and it never performs the recovery
 * it names: replaying a stale session and forking a busy one are the transport's and the failover
 * planner's, which is also why the classes are values in the shared `UpstreamFailureKind` vocabulary
 * rather than a second private enum.
 */

/**
 * How much of the subprocess's stderr is read. Bounded because it is unbounded at the source, and
 * because the tail is where the cause is: a crash prints its reason last.
 */
export const STDERR_TAIL_LIMIT = 2_000

export interface SdkFailureText {
  /** The thrown error's own message. Empty when it had none. */
  readonly message: string
  /** The last {@link STDERR_TAIL_LIMIT} characters of the subprocess's stderr, when it had any. */
  readonly stderrTail: string
}

export interface SdkFailure {
  /** The same shape an HTTP driver produces, so one failover chain reads both transports. */
  readonly classification: FailureClassification
  /**
   * Router-authored and safe to render. It is what a client sees when no account could serve, so it
   * names the class and nothing else — never a path, a session id, or the SDK's own wording.
   */
  readonly clientMessage: string
  /** What was matched against. Kept for the log line; never rendered into a response. */
  readonly text: SdkFailureText
}

/** Lowercased once, matched many times. */
interface Haystack {
  readonly message: string
  /** Message plus the stderr tail. Phrases may match either half. */
  readonly all: string
}

interface SdkRule {
  readonly kind: UpstreamFailureKind
  /** Recorded on the classification so a misclassification is traceable to its trigger. */
  readonly signal: string
  /** What this failure would be answered with if no account could serve the request. */
  readonly status: number
  readonly clientMessage: string
  readonly match: (text: Haystack) => boolean
}

/** Any of these phrases, in the message or the stderr tail. */
function phrase(...needles: readonly string[]): (text: Haystack) => boolean {
  return (text) => needles.some((needle) => text.all.includes(needle))
}

/** All of these phrases, in either half — for a class no single phrase identifies. */
function all(...needles: readonly string[]): (text: Haystack) => boolean {
  return (text) => needles.every((needle) => text.all.includes(needle))
}

/** A bare status number, as a whole word, in the **message** only. See the module note. */
function statusToken(status: number): (text: Haystack) => boolean {
  const pattern = new RegExp(`\\b${status}\\b`)
  return (text) => pattern.test(text.message)
}

/**
 * The table from §9, in order.
 *
 * Provenance: every phrase is the `claude` CLI's own wording, recorded there from Meridian's
 * production matching. Blast radius: a phrase the CLI rewords stops matching and its class degrades
 * to `unknown` — a `502` and a failover, never a silent mislabel. That is why the fallback is honest
 * rather than convenient, and why a reworded rate limit must never quietly become an auth failure.
 */
const RULES: readonly SdkRule[] = [
  {
    kind: "stale-session",
    signal: "claude-sdk:session-not-found",
    status: 502,
    clientMessage: "the Claude Agent SDK session this conversation resumed no longer exists",
    match: phrase("no conversation found with session id"),
  },
  {
    kind: "busy-session",
    signal: "claude-sdk:session-busy",
    status: 503,
    clientMessage: "the Claude Agent SDK session this conversation resumed is still running",
    match: phrase("is currently running as a background agent"),
  },
  {
    /**
     * The one condition non-negotiable 7 forbids conflating with a rate limit: the underlying
     * account is billing-dead, and no clock revives it. `402`, `exhausted`, never timer-retried.
     *
     * Provenance: the CLI (0.3.220 vendored binary) defines the error-message constant
     * `"Credit balance is too low"` in its API-error table (beside `"Not logged in · Please run
     * /login"`), and its own diagnostics list `"credit balance too low"` among Anthropic API error
     * strings; the API's raw sentence ("Your credit balance is too low to access the Anthropic
     * API…") carries the same phrase. Matched as the full phrase rather than a fragment, because a
     * wrong match here parks a healthy account at `402` until a human intervenes — the one
     * misclassification worse than the `unknown` fallback.
     */
    kind: "credits-exhausted",
    signal: "claude-sdk:credit-balance",
    status: 402,
    clientMessage: "the account's credit balance is spent — it needs a top-up, not a retry",
    match: phrase("credit balance is too low"),
  },
  {
    // Cooling down, not `credits-exhausted`: the request asked for a variant the account's plan
    // does not cover right now, and the included window it falls back to refills on a clock. The
    // long-context phrases are the CLI's own wording, verbatim from the 0.3.220 binary (its
    // extended-context error detector matches exactly these two sentences); "out of extra usage"
    // is Meridian's live-observed variant of the same condition (their errors.ts). A spent overage
    // budget still leaves the included window refilling on a clock, so all of them cool down.
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
      )(text),
  },
  {
    kind: "rate-limited",
    signal: "claude-sdk:rate-limited",
    status: 429,
    clientMessage: "the account's Claude subscription window is spent",
    match: phrase("usage limit reached", "rate limit"),
  },
  {
    /**
     * The wording a *plan window* actually uses, which is not the one above. Recorded verbatim from
     * a Max subscription whose weekly window was spent:
     *
     *     "You've hit your weekly limit · resets Jul 30, 11pm (UTC)"
     *
     * It contains neither "usage limit reached" nor "rate limit", so it fell all the way through to
     * `UNCLASSIFIED` — a `500`-shaped unknown for the single most ordinary thing a pooled
     * subscription does. `all("hit your", "limit")` covers the family without reaching further than
     * the evidence: the five-hour variant words it the same way, and requiring both fragments keeps
     * an unrelated sentence containing the word "limit" from matching.
     *
     * `rate-limited`, emphatically: the message states its own reset, so a clock revives this
     * account and CLAUDE.md non-negotiable 7 puts it in `cooling_down` rather than `exhausted` or
     * — worse — `auth`, which would park a working subscription at `needs_reauth`.
     */
    kind: "rate-limited",
    signal: "claude-sdk:plan-window-spent",
    status: 429,
    clientMessage: "the account's Claude subscription window is spent",
    match: all("hit your", "limit"),
  },
  {
    kind: "auth",
    signal: "claude-sdk:credential-expired",
    status: 401,
    clientMessage: "the account's Claude subscription needs re-authenticating",
    match: phrase("oauth token has expired", "not logged in"),
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
    kind: "rate-limited",
    signal: "claude-sdk:status-429",
    status: 429,
    clientMessage: "the account's Claude subscription window is spent",
    match: statusToken(429),
  },
  {
    kind: "auth",
    signal: "claude-sdk:status-401",
    status: 401,
    clientMessage: "the account's Claude subscription needs re-authenticating",
    match: statusToken(401),
  },
]

/**
 * Nothing matched. `502` and a failover, because an unreadable failure is still one account failing
 * and the next one may well serve — the one thing it must not do is name a class it cannot support.
 */
const UNCLASSIFIED: SdkRule = {
  kind: "unknown",
  signal: "claude-sdk:unclassified",
  status: 502,
  clientMessage: "the Claude Agent SDK failed for a reason this router does not recognize",
  match: () => true,
}

export function classifySdkFailure(error: unknown): SdkFailure {
  const text = readSdkFailure(error)
  const haystack: Haystack = {
    message: text.message.toLowerCase(),
    all: `${text.message}\n${text.stderrTail}`.toLowerCase(),
  }
  const rule = RULES.find((candidate) => candidate.match(haystack)) ?? UNCLASSIFIED

  return {
    classification: {
      kind: rule.kind,
      status: rule.status,
      retryable: isRetryableFailureKind(rule.kind),
      signal: rule.signal,
      // Rate-limit *detail* rides the query stream, not the throw: `quota.ts` already folded the
      // reset instant in from the account's own `rate_limit_event`, so inventing one here would
      // overwrite a provider-reported window with a guess.
      rateLimit: null,
      ...(text.message === "" ? {} : { message: text.message }),
    },
    clientMessage: rule.clientMessage,
    text,
  }
}

/** Everything a throw out of `query()` can be matched against, in one bounded shape. */
export function readSdkFailure(error: unknown): SdkFailureText {
  if (typeof error === "string") return { message: error, stderrTail: "" }
  if (typeof error !== "object" || error === null) return { message: "", stderrTail: "" }

  return {
    message: stringProperty(error, "message"),
    stderrTail: tail(stringProperty(error, "stderr")),
  }
}

function stringProperty(source: object, key: string): string {
  const value: unknown = Reflect.get(source, key)
  return typeof value === "string" ? value : ""
}

function tail(value: string): string {
  return value.length <= STDERR_TAIL_LIMIT ? value : value.slice(-STDERR_TAIL_LIMIT)
}

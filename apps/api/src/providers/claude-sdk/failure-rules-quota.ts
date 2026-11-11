import {
  all,
  any,
  CREDITS_SPENT,
  EXTRA_USAGE_GATED,
  pattern,
  phrase,
  type SdkRule,
  WINDOW_SPENT,
} from "./failure-rules-vocabulary"

/**
 * The next six rows of the Agent-SDK failure classification table
 * (docs/idea/11-anthropic-agent-sdk.md §9): the failures that are about *quota* — a model this
 * plan cannot reach, a dead credit balance, Extra Usage spent, a plan window that is spent, or a
 * bare rate limit. They sit after the request rows because each of their sentences is a statement
 * about the account, not about the request.
 *
 * Order inside this array is load-bearing: the credit-balance row must stay ahead of every bare
 * status token (a dead balance arrives as a `400`), and the extra-usage-gated row must stay ahead
 * of overage-required because it is the more specific sentence.
 */
export const SDK_QUOTA_FAILURE_RULES: readonly SdkRule[] = [
  {
    // The CLI's sentence for a model the API does not know or this plan cannot reach — `There's an
    // issue with the selected model (k3). It may not exist or you may not have access to it. Run
    // /model to pick a different model.` (production, 2026-10-04: `k3` and `MiniMax-M3` routed to a
    // subscription). It fell to `unknown`, a `502` that struck the breaker and pushed a healthy
    // account into a recovery probe. `model-unsupported`: retryable — the next account may serve
    // that vendor — and never a strike. `404` is what Anthropic's API answers an unknown model with.
    kind: "model-unsupported",
    signal: "claude-sdk:model-unsupported",
    status: 404,
    clientMessage: "the Claude subscription does not serve the requested model",
    match: phrase(
      "issue with the selected model",
      "may not exist or you may not have access to it",
    ),
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
    // The request's harness fingerprint provokes it on every account alike (`scrub.ts`): fail
    // over, but the account is not out of capacity, so routing must not cool it (101 finding 05.14).
    requestAttributable: true,
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
]

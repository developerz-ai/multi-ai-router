import {
  any,
  apiStatus,
  messagePhrase,
  NEEDS_REAUTH,
  phrase,
  type SdkRule,
  statusToken,
} from "./failure-rules-vocabulary"

/**
 * The last four rows of the Agent-SDK failure classification table
 * (docs/idea/11-anthropic-agent-sdk.md §9), plus the honest fallback: the failures that are about
 * the *account* — a credential refresh that lost the CLI's own lock, a credential that no longer
 * works, a crashed subprocess, and an overloaded upstream.
 *
 * Order inside this array is load-bearing: the refresh-contended row must stay ahead of
 * credential-expired, because the contended spelling contains "could not be refreshed" and would
 * otherwise park a live subscription `needs_reauth` over a lock.
 */
export const SDK_ACCOUNT_FAILURE_RULES: readonly SdkRule[] = [
  {
    // The CLI could not take its own credential-refresh lock: "Failed to refresh OAuth token:
    // another Claude Code process is refreshing it or exited mid-refresh. This is usually
    // transient; retry in a minute, and if it persists close other Claude Code processes or sign
    // in again" (production, v2.13.1 — the SDK reports it as `server_error`, not
    // `authentication_failed`). The 2.1.286 string table has two more spellings of the same
    // condition: "Could not refresh your login because another Claude Code process is refreshing
    // it (or exited mid-refresh)" and "OAuth access token could not be refreshed: another Claude
    // Code process is holding the refresh lock".
    //
    // Ordered ahead of `credential-expired` because that last spelling contains "could not be
    // refreshed" and would otherwise park a live subscription `needs_reauth` over a lock. The
    // credential is not dead and nobody has to log in: the token is the CLI's to refresh
    // (non-negotiables 1 and 13), and the next process to take the lock does. `server-error`, so
    // the chain rotates and a clock — never a human — brings the account back. Matched on the
    // contention half only: a bare "failed to refresh" says nothing about *why*, and the dead
    // variants ("OAuth refresh token is no longer valid") must stay auth.
    kind: "server-error",
    signal: "claude-sdk:credential-refresh-contended",
    status: 503,
    clientMessage:
      "the account's Claude credential was being refreshed by another process; retry shortly",
    match: phrase(
      "another claude code process is refreshing",
      "exited mid-refresh",
      "holding the refresh lock",
    ),
  },
  {
    // Every spelling the CLI has for a credential that no longer works, from the 0.3.220 and
    // 2.1.261 string tables: "OAuth token has expired", "Failed to authenticate: OAuth session
    // expired and could not be refreshed" (production, 2026-09-05 — the refresh token's 30-day
    // hard expiry), "Not logged in · Please run /login", "API Error: 401 Invalid API key · Please
    // run /login", "Session expired. Please run /login"; and from 2.1.286, "OAuth refresh token is
    // no longer valid; run /login to re-authenticate" — the dead half of a failed refresh, where
    // the contended half is the rule above. `authentication failed` is read from the message
    // only: the same words describe an MCP server's own trouble on stderr.
    kind: "auth",
    signal: "claude-sdk:credential-expired",
    status: 401,
    clientMessage: NEEDS_REAUTH,
    match: any(
      phrase(
        "oauth token has expired",
        "oauth session expired",
        "could not be refreshed",
        "refresh token is no longer valid",
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

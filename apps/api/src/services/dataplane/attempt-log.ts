import type { Logger } from "../../logging/logger"
import { redactValue } from "../../logging/redact"
import type { AttemptOutcome } from "./attempt"

/**
 * The one line an operator reads when an attempt fails.
 *
 * Production read `status 502 failureKind server-error` and nothing else while a Claude-subscription
 * pool failed every request: the SDK's own "Failed to authenticate" and the classifier's
 * `claude-sdk:unclassified` never reached the log. So the line carries three more things —
 * `signal`, which rule classified the failure; `reason`, the router-authored sentence the client is
 * owed; and `upstreamMessage`, the provider's (or the SDK's) own complaint, scrubbed and then
 * bounded here (`scrubbedQuote`). The HTTP path redacts the message once already; the Agent-SDK
 * path does not, so this line cannot rely on it.
 */
export function logAttemptFailure(
  log: Logger | undefined,
  accountId: string,
  attempt: number,
  outcome: Extract<AttemptOutcome, { kind: "failure" }>,
  reasonMaxChars: number,
): void {
  log?.warn("upstream attempt failed", {
    accountId,
    attempt,
    status: outcome.failure.status,
    failureKind: outcome.failure.kind,
    signal: outcome.classification?.signal,
    reason: outcome.failure.message,
    upstreamMessage: scrubbedQuote(outcome.classification?.message, reasonMaxChars),
  })
}

/**
 * Characters past the cut still scrubbed, so a credential straddling it is matched whole: room for a
 * ChatGPT access token (a JWT of under 2 KB) that begins just before the cut.
 */
const REDACT_WINDOW_MARGIN = 4096

/**
 * The one line an operator reads when a relayed stream ends in an upstream error (an in-stream
 * Codex refusal, a MiniMax in-body failure, a protocol error). `errorClass` is the closed signal
 * the usage row carries; `upstreamMessage` is the driver hook's reading of the upstream's words,
 * which never reaches a usage row.
 */
export function logStreamFailure(
  log: Logger | undefined,
  accountId: string,
  errorClass: string | null,
  message: string | undefined,
  reasonMaxChars: number,
): void {
  log?.warn("upstream stream failure", {
    accountId,
    errorClass,
    upstreamMessage: scrubbedQuote(message, reasonMaxChars),
  })
}

/**
 * An upstream's own words for a log line: redacted before it is cut, so truncation cannot split a
 * credential below the length its pattern needs and leave a fragment for the logger to miss. Only
 * the part that can be kept is scrubbed, with room for a credential straddling the cut. When the
 * window itself cut the text, its last `REDACT_WINDOW_MARGIN` characters are never kept: a long
 * credential collapsing to `[REDACTED]` earlier would otherwise pull a fragment cut at the window's
 * end into the kept range.
 */
function scrubbedQuote(text: string | undefined, maxChars: number): string | undefined {
  if (text === undefined) return undefined
  const window = maxChars + REDACT_WINDOW_MARGIN
  // Grow the slice by what redaction shrank it, so a token collapsing early still leaves the full
  // bound before the margin. Bounded rounds keep the cost a small multiple of the window.
  let end = window
  let scrubbed = redactValue(text.slice(0, end))
  for (let round = 0; round < MAX_WINDOW_ROUNDS; round++) {
    if (end >= text.length || scrubbed.length >= window) break
    end += window - scrubbed.length
    scrubbed = redactValue(text.slice(0, end))
  }
  if (end >= text.length) return bounded(scrubbed, maxChars)
  const keep = Math.max(0, Math.min(maxChars - 1, scrubbed.length - REDACT_WINDOW_MARGIN))
  return `${scrubbed.slice(0, keep)}…`
}

/** How many times the redaction window may grow to make up for what redaction removed. */
const MAX_WINDOW_ROUNDS = 4

/** An upstream's own words, cut to the configured length for a log line. */
export function bounded(text: string | undefined, maxChars: number): string | undefined {
  if (text === undefined || text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

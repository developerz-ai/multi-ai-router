import type { Logger } from "../../logging/logger"
import { REDACTED, redactValue } from "../../logging/redact"
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
 * end into the kept range. The window doubles, up to `MAX_QUOTE_SCAN_CHARS`, while redaction has
 * shrunk it below a full window, so the words before a long token are still logged.
 */
function scrubbedQuote(text: string | undefined, maxChars: number): string | undefined {
  if (text === undefined) return undefined
  const window = maxChars + REDACT_WINDOW_MARGIN
  let end = window
  let scrubbed = redactValue(text.slice(0, end))
  while (end < text.length && scrubbed.length < window && end < MAX_QUOTE_SCAN_CHARS) {
    end = Math.min(end * 2, MAX_QUOTE_SCAN_CHARS)
    scrubbed = redactValue(text.slice(0, end))
  }
  if (end >= text.length && scrubbed.length <= maxChars) return scrubbed
  const keep =
    end >= text.length
      ? maxChars - 1
      : Math.min(maxChars - 1, scrubbed.length - REDACT_WINDOW_MARGIN)
  return fitted(scrubbed, keep, maxChars)
}

/**
 * The first `keep` characters plus `…`, held within `maxChars` after the logger's own redaction pass.
 * A cut never splits a `[REDACTED]` marker, and a cut that leaves a pattern to re-expand (a
 * `?token=` whose value the cut shortened) is moved back until the re-redacted text fits.
 */
function fitted(scrubbed: string, keep: number, maxChars: number): string {
  let at = keep
  for (let round = 0; round < FIT_ROUNDS && at > 0; round++) {
    const marker = scrubbed.lastIndexOf(REDACTED, at - 1)
    if (marker >= 0 && marker + REDACTED.length > at) at = marker
    const quoted = redactValue(`${scrubbed.slice(0, Math.max(0, at))}…`)
    if (quoted.length <= maxChars) return quoted
    at -= quoted.length - maxChars
  }
  return "…"
}

/** How far the redaction window may grow to make up for what redaction removed. */
const MAX_QUOTE_SCAN_CHARS = 65_536
/** Attempts to pull a cut back until the re-redacted quote fits the bound. */
const FIT_ROUNDS = 4

/** An upstream's own words, cut to the configured length for a log line. */
export function bounded(text: string | undefined, maxChars: number): string | undefined {
  if (text === undefined || text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

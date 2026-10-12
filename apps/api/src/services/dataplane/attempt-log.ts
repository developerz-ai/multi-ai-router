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
 * owed; and `upstreamMessage`, the provider's (or the SDK's) own complaint, bounded here and
 * scrubbed by the logger (`logging/redact.ts`), which is the only thing between an upstream's echo
 * and the line.
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
    upstreamMessage: bounded(outcome.classification?.message, reasonMaxChars),
  })
}

/**
 * The one line an operator reads when a relayed stream ends in an upstream error (an in-stream
 * Codex refusal, a MiniMax in-body failure, a protocol error). `errorClass` is the closed signal
 * the usage row carries; `upstreamMessage` is the driver hook's reading of the upstream's words,
 * which never reaches a usage row. Redacted before it is cut, so truncation cannot split a
 * credential below the length its pattern needs and leave a fragment for the logger to miss.
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
    upstreamMessage: bounded(
      message === undefined ? undefined : redactValue(message),
      reasonMaxChars,
    ),
  })
}

/** An upstream's own words, cut to the configured length for a log line. */
export function bounded(text: string | undefined, maxChars: number): string | undefined {
  if (text === undefined || text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`
}

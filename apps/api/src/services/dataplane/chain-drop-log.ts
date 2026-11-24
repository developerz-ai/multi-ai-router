import type { Logger } from "../../logging/logger"
import type { AttemptOutcome } from "./attempt"

/**
 * Why the chain dropped a candidate without an upstream attempt. Each drop writes no `UsageRecord`
 * of its own, so this line is the only trace that an in-scope account was skipped — and why.
 */
export type CandidateDropReason =
  | "half-open-probe-in-flight"
  | "recovery-admission-refused"
  | "preparation-failed"

/** Drops already named for a request, so one waiting on a permit says so once, not once per poll. */
const named = new WeakMap<object, Set<string>>()

/**
 * A candidate whose recovery permit is not here. One `info` line per request and account: a request
 * re-selecting every 250 ms wrote 20 identical ones (prod 2026-11-23, 185 lines in five hours).
 */
export function logAwaitingPermit(
  log: Logger | undefined,
  request: object,
  accountId: string,
  attempt: number,
): void {
  const seen = named.get(request) ?? new Set<string>()
  if (seen.has(accountId)) return
  seen.add(accountId)
  named.set(request, seen)
  logCandidateDropped(log, accountId, attempt, "recovery-admission-refused")
}

/** One info line per dropped candidate. Fixed vocabulary only — never an error message. */
export function logCandidateDropped(
  log: Logger | undefined,
  accountId: string,
  attempt: number,
  reason: CandidateDropReason,
  errorClass?: string,
): void {
  log?.info("candidate dropped without an upstream attempt", {
    accountId,
    attempt,
    reason,
    ...(errorClass === undefined ? {} : { errorClass }),
  })
}

/** A refused admission, or a failure before the upstream started — dropped, never attempted. */
export function logUnstartedDrop(
  log: Logger | undefined,
  accountId: string,
  attempt: number,
  outcome: Exclude<AttemptOutcome, { readonly kind: "success" }>,
): void {
  if (outcome.kind === "admission-refused")
    logCandidateDropped(log, accountId, attempt, "recovery-admission-refused")
  else logCandidateDropped(log, accountId, attempt, "preparation-failed", outcome.failure.kind)
}

/** Preparation threw. Only the class name is logged — a message may quote an upstream. */
export function logPreparationThrew(
  log: Logger | undefined,
  accountId: string,
  attempt: number,
  error: unknown,
): void {
  const errorClass = error instanceof Error ? error.name : "unknown"
  logCandidateDropped(log, accountId, attempt, "preparation-failed", errorClass)
}

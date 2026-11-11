/**
 * The sentences `no-candidates.ts` renders, split from its classifier: the classifier decides which
 * error a rejection list is; these decide how it reads. Labels only, never credential material.
 */

import type { ResetSource } from "@multi-ai-router/core"
import {
  type GroupDecision,
  RECOVERABLE_FILTER_REASONS,
  type RecoverableFilterReason,
  type RejectedCandidate,
  type ScopeDiagnostics,
} from "./result"

/**
 * The rejected members the leading clause did not describe, each group named by what fixes it.
 * `described` is how many the leading clause covered; the clauses here cover the rest, so the
 * numbers in one message always add up to the pool the request saw.
 */
export function remainder(rejected: readonly RejectedCandidate[], described: number): string {
  if (described === rejected.length) return ""
  const clauses: string[] = []
  const recoverable = rejected.filter((entry) => RECOVERABLE_FILTER_REASONS.includes(entry.reason))
  const exhausted = rejected.filter((entry) => entry.reason === "exhausted")
  const human = rejected.filter(
    (entry) =>
      entry.reason === "disabled" ||
      entry.reason === "needs-reauth" ||
      entry.reason === "credential-rejected",
  )
  const unsupported = rejected.filter((entry) => entry.reason === "model-unsupported")

  // The leading clause is the recoverable group when it is non-empty, else the exhausted one.
  if (recoverable.length > 0 && exhausted.length > 0) {
    clauses.push(
      `${exhausted.length} more ${accountWord(exhausted.length)} out of credits and ${exhausted.length === 1 ? "needs" : "need"} a top-up (${labels(exhausted)})`,
    )
  }
  if (human.length > 0) {
    clauses.push(
      `${human.length} more ${human.length === 1 ? "needs" : "need"} a human (${human.map(describe).join(", ")})`,
    )
  }
  if (unsupported.length > 0) {
    clauses.push(
      `${unsupported.length} more ${unsupported.length === 1 ? "does" : "do"} not serve this model — a client change (${labels(unsupported)})`,
    )
  }
  return clauses.length === 0 ? "" : `; ${clauses.join("; ")}`
}

/**
 * What the recoverable group is waiting on. A recovery-probe hold is the router's own and says
 * nothing about the provider's quota, so it is never worded as quota (prod, 2026-10-04: an account
 * at 18% of its window read "rate limited or out of quota" while it waited on a probe).
 */
export function recoverableCondition(entries: readonly RejectedCandidate[]): string {
  const probe = entries.some((entry) => entry.reason === "probe-in-flight")
  const quota = entries.some((entry) => entry.reason !== "probe-in-flight")
  if (!probe) return "rate limited or out of quota"
  return quota
    ? "rate limited or out of quota, or settling a recovery probe"
    : "settling a recovery probe"
}

/** The condition the message names — `cooling down` for every blocked reason misnamed two of them. */
export function blockedCondition(reason: RecoverableFilterReason): string {
  if (reason === "quota-window-spent") return "out of quota until its window resets"
  if (reason === "probe-in-flight") return "settling a recovery probe"
  return "cooling down"
}

export function poolNames(groups: readonly GroupDecision[]): string[] {
  return groups.map((group) => group.poolName).filter((name): name is string => name !== null)
}

export function where(groups: readonly GroupDecision[]): string {
  const named = poolNames(groups)
  if (named.length === 0) return ""
  if (named.length === 1) return ` in pool ${named[0]}`
  return ` in pools ${named.join(", ")}`
}

export function unresolved(scope: ScopeDiagnostics): string {
  const count = scope.unresolvedTargetIds.length
  return count === 0
    ? ""
    : ` (${count} scope ${count === 1 ? "target" : "targets"} no longer exist)`
}

export function labels(entries: readonly RejectedCandidate[]): string {
  return entries.map((entry) => entry.label).join(", ")
}

/**
 * `kimi needs re-auth`, `ollama disabled` — the label and the condition, in the operator's words.
 *
 * `disabled` is said only of an account the operator switched off. A key the provider refused is
 * named as that, with when the router will try it again — the one thing an operator reading this
 * needs to know to tell "fix the key" from "wait".
 */
export function describe(entry: RejectedCandidate): string {
  if (entry.reason === "needs-reauth") return `${entry.label} needs re-auth`
  if (entry.reason === "credential-rejected") {
    const retest =
      entry.resetsAt === undefined
        ? ""
        : `, re-checked after ${entry.resetsAt.toISOString()}${qualifier(entry.resetSource)}`
    return `${entry.label} credential rejected upstream${retest}`
  }
  return `${entry.label} ${entry.reason}`
}

/** ` (estimated)` beside an instant the provider did not report itself; nothing beside one it did. */
export function qualifier(source: ResetSource | undefined): string {
  return source === undefined || source === "provider-reported" ? "" : ` (${source})`
}

export function accountWord(count: number): string {
  return count === 1 ? "account" : "accounts"
}

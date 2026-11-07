import type { FailureClassification, RateLimitSignal, UpstreamFailureKind } from "../../providers"
import { type AttemptFailure, classifyStatus, type FailureKind } from "../routing"
import { redactAttemptText } from "./error-body"

/** An attempt's verdict in failover's vocabulary: split from `attempt.ts`, which sends it. */

/**
 * The driver's vocabulary mapped onto failover's. `unknown` falls back to what the status says.
 *
 * `busy-session` and `subprocess-crash` land on `server-error` deliberately: by the time either
 * reaches the failover chain the SDK transport has already spent its own recovery — the waits, the
 * fork — so what is left is one account that could not serve, which is what `server-error` means.
 * `stale-session` is the exception the planner reads by name, because its recovery is a replay on
 * that same account (docs/idea/11-anthropic-agent-sdk.md §9).
 */
const FAILURE_KINDS: Readonly<Record<UpstreamFailureKind, FailureKind | null>> = {
  "rate-limited": "rate-limited",
  "credits-exhausted": "credits-exhausted",
  auth: "auth",
  "invalid-request": "client-error",
  "model-unsupported": "model-unsupported",
  "server-error": "server-error",
  // Its own kind on this side too: retryable, but never held against the account (`breaker.ts`).
  overloaded: "overloaded",
  "stale-session": "stale-session",
  // Not `server-error`: it is retryable — the SDK transport already spent its in-place fork — but
  // it is a fact about the conversation's session rather than about this account, so it must not
  // strike the breaker (`routing/breaker.ts`).
  "busy-session": "busy-session",
  "subprocess-crash": "server-error",
  unknown: null,
}

/** Shared with the Agent-SDK transport, which classifies prose into the same vocabulary. */
export function failoverKind(kind: UpstreamFailureKind | null, status: number): FailureKind {
  const mapped = kind === null ? null : FAILURE_KINDS[kind]
  return mapped ?? classifyStatus(status) ?? "server-error"
}

export function toAttemptFailure(
  status: number,
  classification: FailureClassification | null,
  rateLimit: RateLimitSignal | null,
): AttemptFailure {
  const kind = failoverKind(classification?.kind ?? null, status)
  const signal = classification?.rateLimit ?? rateLimit

  return {
    kind,
    status,
    resetsAt: signal?.resetsAt,
    retryAfterSeconds: signal?.retryAfterSeconds,
    resetSource: signal?.resetSource,
    message: classification?.signal ?? `upstream returned ${status}`,
  }
}

export function redactClassification(
  classified: FailureClassification,
  secrets: readonly string[],
): FailureClassification {
  return {
    ...classified,
    ...(classified.message === undefined
      ? {}
      : { message: redactAttemptText(classified.message, secrets) }),
    signal: redactAttemptText(classified.signal, secrets),
  }
}

export function transportFailure(error: unknown): AttemptFailure {
  const name = error instanceof Error ? error.name : ""
  const timedOut = name === "TimeoutError" || name === "AbortError"
  return {
    kind: timedOut ? "timeout" : "connection",
    message: timedOut
      ? "upstream did not answer within its deadline"
      : "upstream connection failed",
  }
}

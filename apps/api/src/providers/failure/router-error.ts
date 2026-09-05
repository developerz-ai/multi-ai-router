import {
  CreditsExhaustedError,
  QuotaExhaustedError,
  type RouterError,
  UpstreamAuthError,
} from "@multi-ai-router/core"
import type { FailureClassification, RateLimitSignal } from "../types"

/**
 * The classifications the router answers for itself, mapped onto the error hierarchy. Every
 * status comes from the class, never from a second table here (`packages/core` owns that).
 *
 * Three kinds have router semantics a passthrough cannot express: a `Retry-After` the client can
 * act on, a `402` saying a human must top up, and a `502` saying the *Account's* credential
 * failed — not the caller's. Answering that last one with the upstream's own `401` would tell a
 * developer their router key was rejected when the operator is the one who has to re-authenticate.
 *
 * `null` for the rest on purpose: a bad request is bad at every account, and returning the
 * upstream's own error unchanged is the honest answer (docs/idea/06-protocol-translation.md).
 *
 * Messages are router-authored. An upstream message can echo request content back, and no
 * client-facing error body carries anything we did not write ourselves.
 */

/**
 * What the attempt knew beside its classification.
 *
 * `signal` is the rate-limit reading that rode *beside* the classification, when the classification
 * itself carries none. The Agent-SDK transport is the case: its reset instant arrives as a
 * `rate_limit_event` inside the query stream, never on the throw, so `classifySdkFailure` pins
 * `classification.rateLimit` to null and the attempt's captured signal is the only source. `now`
 * is the attempt's clock reading, injected because the seconds a `Retry-After` counts are derived
 * from the reported instant — this module still reads no clock of its own.
 */
export interface FailureContext {
  readonly signal: RateLimitSignal | null
  readonly now: Date
  /**
   * The router-authored sentence for this failure, when the transport had one that says more than
   * the class does (`SdkFailure.clientMessage`). Read for the `429` alone, because that is the one
   * verdict where the classes differ in remedy and not just in wording: a spent plan window and a
   * request Anthropic metered against Extra Usage are both `rate-limited`, and only the second has
   * somewhere for the operator to go. Router-authored by contract — an upstream's own words never
   * reach a client-facing body.
   */
  readonly clientMessage?: string
}

export function toRouterError(
  classification: FailureClassification,
  context?: FailureContext,
): RouterError | null {
  if (classification.kind === "rate-limited") {
    const signal = classification.rateLimit ?? context?.signal ?? null
    const resetsAt = signal?.resetsAt
    // A `429` without a `Retry-After` makes a client guess, and guessing clients retry in
    // lockstep (non-negotiable 7). When only the instant was reported, the wait is derived.
    const retryAfterSeconds =
      signal?.retryAfterSeconds ??
      (resetsAt !== undefined && context !== undefined
        ? secondsUntil(resetsAt, context.now)
        : undefined)
    const stated = context?.clientMessage
    return new QuotaExhaustedError(
      stated === undefined
        ? `upstream rate limited (${classification.signal})`
        : `${stated} (${classification.signal})`,
      { retryAfterSeconds, resetsAt },
    )
  }

  if (classification.kind === "credits-exhausted") {
    return new CreditsExhaustedError(
      `upstream account is out of credits (${classification.signal}) — needs a top-up, no timer will fix it`,
    )
  }

  if (classification.kind === "auth") {
    return new UpstreamAuthError(
      `upstream rejected the account's credential (${classification.signal}) — the account needs re-authenticating, the presented router key was fine`,
    )
  }

  return null
}

/** At least one second: a `Retry-After: 0` invites an immediate retry into the same wall. */
function secondsUntil(resetsAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((resetsAt.getTime() - now.getTime()) / 1000))
}

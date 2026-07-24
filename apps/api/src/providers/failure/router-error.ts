import {
  CreditsExhaustedError,
  QuotaExhaustedError,
  type RouterError,
  UpstreamAuthError,
} from "@multi-ai-router/core"
import type { FailureClassification } from "../types"

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
export function toRouterError(classification: FailureClassification): RouterError | null {
  if (classification.kind === "rate-limited") {
    const rateLimit = classification.rateLimit
    return new QuotaExhaustedError(`upstream rate limited (${classification.signal})`, {
      retryAfterSeconds: rateLimit?.retryAfterSeconds,
      resetsAt: rateLimit?.resetsAt,
    })
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

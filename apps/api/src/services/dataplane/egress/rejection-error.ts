import { NoHealthyAccountError, type RouterError, TranslationError } from "@multi-ai-router/core"
import type { EgressRejection } from "./mode"

/**
 * The client-facing failure when no candidate could be served.
 *
 * A missing translator is a `400` — the request as sent has no faithful representation on any
 * account this key can reach, which is a fact about the request rather than about capacity, and a
 * caller can act on it by calling a different ingress path. An unimplemented provider is a `503`:
 * the caller did nothing wrong and there is nothing they can change, so answering `400` would send
 * them looking in the wrong place.
 *
 * An unsupported *operation* is a `503` for that second reason and not the first, even though it
 * also refuses a request before any upstream call. A `count_tokens` or `embeddings` body is a
 * perfectly valid request of its dialect and there is no other ingress path to send it down — what
 * is missing is an account that states the endpoint, which only the operator can add.
 */
export function egressRejectionError(rejection: EgressRejection): RouterError {
  if (rejection.reason === "no-translator") return new TranslationError(rejection.message)
  // No account in this scope performs the operation: another key or route, not a wait.
  if (rejection.reason === "unsupported-operation")
    return new NoHealthyAccountError(rejection.message, { wall: "scope" })
  // `unimplemented`: an account whose provider this build has no driver for. No retry fixes that;
  // an operator removes the account or deploys a build that has one.
  return new NoHealthyAccountError(rejection.message, { wall: "human" })
}

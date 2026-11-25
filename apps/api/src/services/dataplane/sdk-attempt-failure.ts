import {
  AccountAtCapacityError,
  DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS as DEFAULT_GATE_RETRY_AFTER_SECONDS,
  NoHealthyAccountError,
} from "@multi-ai-router/core"
import {
  classifySdkFailure,
  type RateLimitSignal,
  SdkGateWaitExpiredError,
  type SessionTurn,
} from "../../providers"
import { type AttemptOutcome, failoverKind } from "./attempt"
import type { SdkAttemptInput } from "./sdk-attempt"
import { sdkCancellation } from "./sdk-cancellation"

/**
 * How one Agent-SDK attempt ends when its invocation throws before a response exists: a cancellation,
 * a full gate, or a classified subprocess failure. Split from `sdk-attempt.ts`, which runs the
 * attempt; this decides what its throw means.
 */

export const NO_TRANSPORT =
  "no Claude Agent SDK transport is configured on this router: a subscription account cannot be dispatched to"

export const DEADLINE = "the Agent SDK did not answer within its deadline"

export const ACCOUNT_FULL_MESSAGE =
  "the Claude subscription account is at its in-flight limit (account-at-capacity)"
export const ROUTER_FULL_MESSAGE =
  "this router replica is at its Claude concurrency limit (router-at-capacity)"

/**
 * A full gate, as an attempt failure and the router's own verdict. Both kinds are blameless
 * (`breaker.ts`) and fire before the upstream starts, so the outcome carries its verdict for the
 * chain to take the failure tail on (`chain.ts`). The `Retry-After` is the router's existing wait
 * for a wall that names no instant: a full gate names none either, and the router invents none.
 */
function gateRefusal(error: SdkGateWaitExpiredError, retryAfterSeconds: number): AttemptOutcome {
  const account = error.half === "account"
  const message = account ? ACCOUNT_FULL_MESSAGE : ROUTER_FULL_MESSAGE
  const signal = account ? "account-at-capacity" : "router-at-capacity"
  return {
    kind: "failure",
    failure: { kind: account ? "account-full" : "router-full", message },
    classification: null,
    rateLimit: null,
    // No upstream was reached: the gate in front of it was full.
    upstream: null,
    errorClass: signal,
    // The attempt log's `signal` field: no classification exists to carry it.
    upstreamSignal: signal,
    verdict: account
      ? new AccountAtCapacityError(message, { retryAfterSeconds, detail: { signal } })
      : new NoHealthyAccountError(message, {
          wall: "capacity",
          retryAfterSeconds,
          // A replica's memory bound is not a fact about any account.
          detail: { scope: "router", signal },
        }),
  }
}

/** Abort-shaped throws use the first signal cause; provider failures retain their classification. */
export function invocationFailure(
  error: unknown,
  input: SdkAttemptInput,
  turn: SessionTurn,
  rateLimit: RateLimitSignal | null,
  attemptSignal: AbortSignal,
): AttemptOutcome {
  // Ahead of the classifier: its own typed throw is not subprocess prose to be read for a rule.
  if (error instanceof SdkGateWaitExpiredError)
    return gateRefusal(error, input.gateWait?.retryAfterSeconds ?? DEFAULT_GATE_RETRY_AFTER_SECONDS)
  const cancellation = sdkCancellation(error, attemptSignal, input.signal)
  if (cancellation === "caller")
    return {
      kind: "failure",
      failure: { kind: "client-error", status: 499, message: "client cancelled the request" },
      classification: null,
      rateLimit: null,
      upstream: null,
    }
  if (cancellation === "deadline") return failure("timeout", DEADLINE)

  const { classification, clientMessage } = classifySdkFailure(error)
  if (classification.kind === "stale-session") evictBinding(input, turn)

  return {
    kind: "failure",
    failure: {
      kind: failoverKind(classification.kind, classification.status),
      status: classification.status,
      // Router-authored: this is the sentence a client reads when no account could serve, and the
      // SDK's own wording never becomes one (docs/idea/07-security.md).
      message: clientMessage,
      ...(classification.requestAttributable === true ? { requestAttributable: true } : {}),
      ...(classification.permanentForRequest === true ? { permanentForRequest: true } : {}),
      ...(classification.modelScoped === true ? { modelScoped: true } : {}),
    },
    classification,
    // The account's quota state rides `rate_limit_event`, never the throw (§5), and `classifySdkFailure`
    // never invents one (`classification.rateLimit` is always null), so whatever this attempt's own
    // stream reported is the only source.
    rateLimit,
    upstream: null,
  }
}

/**
 * The SDK says it has never heard of the session we resumed, so the binding that named it is wrong
 * and stays wrong. Dropped rather than moved: an SDK session id resumes nowhere but the Account that
 * minted it, and this one resumes nowhere at all.
 */
function evictBinding(input: SdkAttemptInput, turn: SessionTurn): void {
  const session = input.session
  // A fresh turn resumed nothing, so there is no binding this failure discredits.
  if (session === undefined || turn.plan.kind === "fresh") return
  session.store.invalidate(session.apiKeyId, session.sessionKey)
}

export function failure(kind: "timeout" | "server-error", message: string): AttemptOutcome {
  return {
    kind: "failure",
    failure: { kind, message },
    classification: null,
    rateLimit: null,
    // Nothing answered, so there is no upstream body to relay. The chain surfaces a router-shaped
    // error instead of inventing a provider-shaped one.
    upstream: null,
  }
}

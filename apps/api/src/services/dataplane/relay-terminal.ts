import type { UsageOutcome } from "@multi-ai-router/core"
import type { AttemptFailure, FailureKind } from "../routing"
import { TranslationStreamError } from "../translate/shared/stream-error"
import type { ResponseObservationFacts } from "../usage/response-observer-types"
import { RouterShutdownError } from "./active-requests"
import { failoverKind } from "./attempt"
import { failureOutcome } from "./records"
import { ClientCancelledError } from "./relay-cancellation"

export interface RelayVerdict {
  readonly outcome: UsageOutcome
  readonly errorClass: string | null
  readonly failure: AttemptFailure | null
  readonly recovery: "succeeded" | "failed" | "uncertain"
}
const success: RelayVerdict = {
  outcome: "success",
  errorClass: null,
  failure: null,
  recovery: "succeeded",
}

/**
 * The shape every hook signal has (`<driver>:<rule>-<listed value>`). `errorClass` is the
 * `error_class` metric label; this bounds its charset and length and turns an upstream sentence into
 * the protocol default. It is not an allowlist: label cardinality rests on each hook building its
 * signal from a closed list, as both current hooks do.
 */
export const HOOK_SIGNAL = /^[a-z0-9-]+:[a-z0-9_:-]{1,64}$/

/** A response that stopped short: the upstream said so, or it ended with no ending at all. */
export const UPSTREAM_INCOMPLETE = "upstream_incomplete"

/** The hook's closed signal when a driver hook answered, else the protocol default. */
function explicitErrorClass(facts: ResponseObservationFacts): string {
  const signal = facts.provider?.signal
  return signal !== undefined && HOOK_SIGNAL.test(signal) ? signal : "upstream_protocol_error"
}

/** What an in-stream failure proves about the account: the same reading as `chain-recovery.ts`. */
function streamRecovery(kind: FailureKind): RelayVerdict["recovery"] {
  // The upstream judged the request, so the account answered.
  if (kind === "client-error" || kind === "model-unsupported") return "succeeded"
  // Its shared backend was busy: nothing about this account either way.
  return kind === "overloaded" ? "uncertain" : "failed"
}

/**
 * The upstream's stream ended cleanly with no ending of its own. The translator already told the
 * client so (`translate/shared/stream-truncated.ts`); this is what the row records instead of a
 * success nobody received.
 */
export class UpstreamTruncatedError extends Error {
  constructor() {
    super("upstream stream ended before its final event")
    this.name = "UpstreamTruncatedError"
  }
}

/** First observed causal evidence wins; mutable abort state never rewrites a verdict. */
export function createRelayTerminal() {
  let first: RelayVerdict | undefined
  const capture = (verdict: RelayVerdict) => {
    first ??= verdict
  }
  return {
    observe(facts: ResponseObservationFacts) {
      if (
        facts.failure !== null ||
        facts.terminal === "explicit_error" ||
        facts.terminal === "explicit_incomplete"
      ) {
        const errorClass =
          facts.terminal === "explicit_error" ? explicitErrorClass(facts) : UPSTREAM_INCOMPLETE
        const kind =
          facts.failure === null ? null : failoverKind(facts.failure.kind, facts.failure.status)
        capture({
          outcome: kind === null ? "upstream_error" : failureOutcome(kind),
          errorClass,
          failure:
            facts.failure === null || kind === null
              ? null
              : { kind, status: facts.failure.status, message: "upstream protocol failure" },
          recovery: kind === null ? "uncertain" : streamRecovery(kind),
        })
      }
    },
    /**
     * `modelOutput`: the upstream already streamed model content. A client that cancels after that
     * has proof the account served, so recovery settles `succeeded` — holding a demonstrably healthy
     * account behind another probe would be the router's fault, not the account's. A cancel before
     * any model output proves nothing either way and stays `uncertain`.
     */
    error(error: unknown, modelOutput = false, transportClass?: string) {
      if (error instanceof TranslationStreamError) {
        capture({
          outcome: "router_error",
          errorClass: error.errorClass,
          failure: null,
          recovery: "uncertain",
        })
      } else if (error instanceof UpstreamTruncatedError) {
        capture({
          outcome: "upstream_error",
          errorClass: UPSTREAM_INCOMPLETE,
          failure: null,
          recovery: "uncertain",
        })
      } else if (error instanceof RouterShutdownError) {
        capture({
          outcome: "router_error",
          errorClass: "router_shutdown",
          failure: null,
          recovery: "uncertain",
        })
      } else if (error instanceof ClientCancelledError) {
        capture({
          outcome: "client_error",
          errorClass: "client_cancelled",
          failure: null,
          recovery: modelOutput ? "succeeded" : "uncertain",
        })
      } else {
        const timedOut = error instanceof Error && error.name === "TimeoutError"
        capture({
          outcome: timedOut ? "upstream_timeout" : "upstream_error",
          // A driver's stream-cap signal names an upstream-dropped stream (`stream-cap.ts`).
          errorClass: timedOut ? "upstream_timeout" : (transportClass ?? "upstream_error"),
          failure: {
            kind: timedOut ? "timeout" : "connection",
            message: "upstream transport failure",
          },
          recovery: "failed",
        })
      }
    },
    finish(facts: ResponseObservationFacts): RelayVerdict {
      this.observe(facts)
      return first ?? success
    },
  }
}

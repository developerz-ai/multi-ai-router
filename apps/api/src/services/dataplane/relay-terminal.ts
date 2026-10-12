import type { UsageOutcome } from "@multi-ai-router/core"
import type { AttemptFailure } from "../routing"
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
const HOOK_SIGNAL = /^[a-z0-9-]+:[a-z0-9_:-]{1,64}$/

/** The hook's closed signal when a driver hook answered, else the protocol default. */
function explicitErrorClass(facts: ResponseObservationFacts): string {
  const signal = facts.provider?.signal
  return signal !== undefined && HOOK_SIGNAL.test(signal) ? signal : "upstream_protocol_error"
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
          facts.terminal === "explicit_error" ? explicitErrorClass(facts) : "upstream_incomplete"
        capture({
          outcome:
            facts.failure === null
              ? "upstream_error"
              : failureOutcome(failoverKind(facts.failure.kind, facts.failure.status)),
          errorClass,
          failure:
            facts.failure === null
              ? null
              : {
                  kind: failoverKind(facts.failure.kind, facts.failure.status),
                  status: facts.failure.status,
                  message: "upstream protocol failure",
                },
          recovery: facts.failure === null ? "uncertain" : "failed",
        })
      }
    },
    /**
     * `modelOutput`: the upstream already streamed model content. A client that cancels after that
     * has proof the account served, so recovery settles `succeeded` — holding a demonstrably healthy
     * account behind another probe would be the router's fault, not the account's. A cancel before
     * any model output proves nothing either way and stays `uncertain`.
     */
    error(error: unknown, modelOutput = false) {
      if (error instanceof TranslationStreamError) {
        capture({
          outcome: "router_error",
          errorClass: error.errorClass,
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
          errorClass: timedOut ? "upstream_timeout" : "upstream_error",
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

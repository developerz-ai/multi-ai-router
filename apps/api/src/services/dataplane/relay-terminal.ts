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
        capture({
          outcome:
            facts.failure === null
              ? "upstream_error"
              : failureOutcome(failoverKind(facts.failure.kind, facts.failure.status)),
          errorClass:
            facts.terminal === "explicit_error" ? "upstream_protocol_error" : "upstream_incomplete",
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
    error(error: unknown) {
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
          recovery: "uncertain",
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

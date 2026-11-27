import type { SdkRefusalEvidence, SdkTransportReport } from "../../providers"
import type { AttemptOutcome } from "./attempt"
import type { AttemptEvidence } from "./attempt-evidence"

/**
 * One Claude attempt's evidence for its failure line (#509), gathered off the invocation's
 * callbacks. The last transport report wins: it names the invoker that produced the outcome, so a
 * fast transport that fell back onto the SDK is logged as the SDK. No report, no transport: the
 * field is never guessed from the code path.
 */
export function createEvidenceCapture() {
  let report: SdkTransportReport | undefined
  let refusal: SdkRefusalEvidence | undefined
  return {
    onTransport: (next: SdkTransportReport) => {
      report = next
    },
    onRefusalEvidence: (next: SdkRefusalEvidence | undefined) => {
      refusal = next
    },
    /**
     * `refused`: the outcome is the transport's own refusal, so its in-flight count and headers
     * describe it. Anywhere else the count could be read after the slot was given back.
     */
    evidence(refused: boolean): AttemptEvidence | undefined {
      const fromRefusal = refused && refusal !== undefined ? refusal : undefined
      if (report === undefined && fromRefusal === undefined) return undefined
      return {
        ...(report === undefined
          ? {}
          : {
              transport: report.transport,
              model: report.model,
              ...(report.scrubRules === undefined ? {} : { scrubRules: report.scrubRules }),
            }),
        ...(fromRefusal === undefined
          ? {}
          : { inFlight: fromRefusal.inFlight, headers: fromRefusal.headers }),
      }
    },
  }
}

/** The outcome, carrying the evidence when it is a failure and there is any. */
export function withEvidence(
  outcome: AttemptOutcome,
  evidence: AttemptEvidence | undefined,
): AttemptOutcome {
  return outcome.kind === "failure" && evidence !== undefined ? { ...outcome, evidence } : outcome
}

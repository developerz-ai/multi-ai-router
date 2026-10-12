import type { Dialect } from "@multi-ai-router/core"
import type { FailureClassification, ResponseObservationDescriptor } from "../../providers/types"
import type { TokenCounts } from "./tokens"

export interface ResponseObservationSpec {
  readonly dialect: Dialect
  readonly operation: "messages" | "count-tokens" | "embeddings"
  readonly contentType: string | null
  readonly maximumObservationBytes: number
  readonly descriptor?: ResponseObservationDescriptor
}
export interface ResponseObservationFacts {
  readonly counts: TokenCounts
  readonly usageInvalid: boolean
  readonly evidenceUnavailable: boolean
  readonly terminal: "none" | "completed" | "explicit_error" | "explicit_incomplete"
  readonly failure: FailureClassification | null
  readonly incompleteReason: "max_output_tokens" | "content_filter" | "unknown" | null
  /**
   * The driver-supplied classification, when its `inspectPayload` answered non-null on a parsed
   * frame. When set, `relay-terminal` reads this row's `signal` as the verdict's `errorClass`;
   * when null, the verdict keeps the protocol-default `upstream_protocol_error`. The classification
   * itself is the one passed to `health.recordFailure`, not a separate value.
   */
  readonly provider: FailureClassification | null
}
export interface ResponseObserver {
  observe(chunk: Uint8Array): void
  snapshot(): ResponseObservationFacts
  finish(): ResponseObservationFacts
  /** Retained wire bytes, for bounded-state diagnostics; never response contents. */
  readonly retainedBytes: number
}

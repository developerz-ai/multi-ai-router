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
}
export interface ResponseObserver {
  observe(chunk: Uint8Array): void
  snapshot(): ResponseObservationFacts
  finish(): ResponseObservationFacts
  /** Retained wire bytes, for bounded-state diagnostics; never response contents. */
  readonly retainedBytes: number
}

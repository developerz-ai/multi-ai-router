import type { Dialect } from "@multi-ai-router/core"
import type { FailureClassification, ResponseObservationDescriptor } from "../../providers/types"
import type { TokenCounts } from "./tokens"

/**
 * `contentFrames`: whether the `inspectPayload` hook needs content frames (deltas, block start/stop,
 * ping). Absent means it does, which keeps every frame parsed. Read per frame, so a getter may flip
 * it once the hook has seen what it needed.
 */
export type ObservationDescriptor = ResponseObservationDescriptor & {
  readonly contentFrames?: "inspect" | "skip"
}
export interface ResponseObservationSpec {
  readonly dialect: Dialect
  readonly operation: "messages" | "count-tokens" | "embeddings"
  readonly contentType: string | null
  readonly maximumObservationBytes: number
  readonly descriptor?: ObservationDescriptor
  /**
   * A tap on every frame the observer parses, called before usage and terminal are read. It lets
   * a caller that also classifies frames (the success-wall peek) ride on this one parse rather
   * than framing and parsing the same bytes a second time. Must not throw; a throw marks the
   * frame's evidence unavailable, as a malformed frame would.
   */
  readonly onPayload?: (payload: unknown, event: string | undefined) => void
}
export interface ResponseObservationFacts {
  readonly counts: TokenCounts
  readonly usageInvalid: boolean
  /**
   * The upstream stated a usage sample the reader accepted. False means the token counts are no
   * measurement at all, which is different from a measured zero (`usage-unread.ts`).
   */
  readonly usageStated: boolean
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
  /** The same frozen facts until a frame changes them; cheap to call per chunk. */
  snapshot(): ResponseObservationFacts
  /** Live reads for a per-chunk check that needs no snapshot (relay: has a verdict landed?). */
  readonly terminal: ResponseObservationFacts["terminal"]
  readonly failure: ResponseObservationFacts["failure"]
  /**
   * Moves whenever the facts may have changed (a frame read, evidence lost, end of body); equal
   * revisions mean `snapshot()` returns the identical object.
   */
  readonly revision: number
  finish(): ResponseObservationFacts
  /** Retained wire bytes, for bounded-state diagnostics; never response contents. */
  readonly retainedBytes: number
}

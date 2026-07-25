/**
 * Re-synthesis: SDK messages in, an Anthropic Messages response out.
 *
 * `renderSdkResponse` is the only entry point a caller needs; everything else is exported for the
 * tests that assert one narrowing at a time (docs/idea/11-anthropic-agent-sdk.md §6).
 */

export type { ClientFrame, Completion, Envelope, EnvelopeOptions } from "./envelope"
export { createEnvelope } from "./envelope"
export type { MessageFacts, SdkMessageView, SdkUsage, StopFacts, WireEvent } from "./events"
export { readMessageFacts, readSdkMessage, readStopFacts, readUsage, readWireEvent } from "./events"
export type { IdleGuard, IdleGuardInput, StreamPacing, Ticker } from "./idle-guard"
export { createIdleGuard, DEFAULT_STREAM_PACING, systemTicker } from "./idle-guard"
export type { BlockDecision, BlockIndexMap } from "./index-map"
export { createBlockIndexMap, withClientIndex } from "./index-map"
export type { MessageFold } from "./message"
export { createMessageFold } from "./message"
export type { SdkRenderInput, SdkRenderObserver } from "./stream"
export { renderSdkResponse } from "./stream"

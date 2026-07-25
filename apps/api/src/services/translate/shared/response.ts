/**
 * What a non-streaming response translator hands back.
 *
 * The body is a plain JSON value, ready to serialize — a translator never encodes, because the
 * caller is the one that knows whether the bytes are going onto a stream or into a `Response`.
 *
 * `unrecognizedStopReason` is the same contract the streaming side states in `sse/emit.ts`: a
 * translator is a pure function with no logger behind it, so a stop reason this build does not
 * define is **returned** for the caller — which holds the request id — to log. One line per
 * provider change, none in steady state (`06-protocol-translation.md#stop-and-finish-reasons`).
 */
export interface TranslatedResponse {
  readonly body: unknown
  readonly unrecognizedStopReason: string | null
}

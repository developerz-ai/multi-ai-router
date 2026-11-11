import { TranslationStreamError } from "./stream-error"

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
  /**
   * Set when the upstream answer cannot be represented honestly in the client's dialect — a tool
   * call whose `arguments` do not decode to an object, which Anthropic's `input` has no form for.
   * The caller renders this error in the ingress dialect instead of `body`: nothing is on the wire
   * yet, and a call with invented arguments is one the client would run. Absent means none.
   */
  readonly translationFailure?: TranslationStreamError | undefined
}

/**
 * The failure for an upstream tool call whose arguments do not decode to an object. Names the
 * call's position, never its arguments: they are model output the client never saw.
 */
export function undecodableToolArguments(index: number): TranslationStreamError {
  return new TranslationStreamError(
    "translation_protocol_error",
    `The upstream answered with tool call ${index} whose arguments are not a JSON object; the call cannot be represented without inventing its input`,
  )
}

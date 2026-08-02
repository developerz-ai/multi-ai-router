import type { SdkUsage } from "./events"

/**
 * Frame construction and hygiene for the envelope (`envelope.ts`): the two `message_start` shapes,
 * the terminal usage block, and the one named-field deletion applied to every outgoing frame.
 * Pure functions over plain objects — the envelope keeps the state, this file keeps the shapes.
 */

/** A client-visible Anthropic SSE frame. The object *is* the `data:` payload. */
export type ClientFrame = Readonly<Record<string, unknown>> & { readonly type: string }

/**
 * `message_delta`'s usage block.
 *
 * `output_tokens` is required by the shape and is therefore the one count stated unconditionally.
 * Everything else appears only when the SDK actually counted it — the same rule
 * `services/translate/shared/usage.ts` applies at every other seam, for the same reason: a zero
 * written for a number nobody measured is invented data.
 */
export function outputCounts(usage: SdkUsage | null): Record<string, number> {
  const counts: Record<string, number> = { output_tokens: usage?.output_tokens ?? 0 }
  if (usage === null) return counts
  if (usage.input_tokens !== null) counts.input_tokens = usage.input_tokens
  if (usage.cache_creation_input_tokens !== null) {
    counts.cache_creation_input_tokens = usage.cache_creation_input_tokens
  }
  if (usage.cache_read_input_tokens !== null) {
    counts.cache_read_input_tokens = usage.cache_read_input_tokens
  }
  return counts
}

/**
 * The SDK's `message_start`, with the id and model the client will be told about.
 *
 * A shallow rewrite of two fields rather than a rebuild: everything else the upstream stated —
 * `role`, `content`, `usage`, fields this build has never heard of — is the Anthropic dialect
 * already and is forwarded exactly as it arrived.
 */
export function normalizedStart(
  raw: Readonly<Record<string, unknown>>,
  id: string,
  model: string,
): ClientFrame {
  const message = isRecord(raw.message) ? raw.message : {}
  return { ...raw, type: "message_start", message: { ...message, id, model } }
}

/**
 * The `message_start` for a turn that never sent one — a tool-only turn, a structured-output turn,
 * or an error close before the first content block.
 *
 * `content: []` is the point: an empty completion is the honest answer when the model produced
 * nothing, and the counts are stated in the terminal `message_delta` where the real ones live.
 */
export function synthesizedStart(id: string, model: string): ClientFrame {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }
}

/**
 * Deletes the one field the SDK/CLI attaches to streamed events that the real Anthropic API never
 * emits: `context_management`, on the event and on `event.delta` (advisory metadata about upstream
 * context edits that already happened). Stock Anthropic SDK clients treat any present field as a
 * typed model and crash on the raw object — observed in the wild against langchain-anthropic
 * (Meridian #525, whose strip this mirrors). A narrow named deletion, in the same spirit as
 * tool-name un-prefixing: everything else in the frame is forwarded byte-identical.
 */
export function stripContextManagement(frame: ClientFrame): ClientFrame {
  const topLevel = "context_management" in frame
  const inDelta = isRecord(frame.delta) && "context_management" in frame.delta
  if (!topLevel && !inDelta) return frame

  const { context_management: _dropped, ...rest } = frame
  if (isRecord(rest.delta) && "context_management" in rest.delta) {
    const { context_management: _droppedDelta, ...delta } = rest.delta
    return { ...rest, delta }
  }
  return rest
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 122 bits from the platform CSPRNG. Unique across replicas, unlike anything clock-derived. */
export function randomMessageId(): string {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`
}

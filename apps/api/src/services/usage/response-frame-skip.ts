import type { Dialect } from "@multi-ai-router/core"
import type { ResponseObservationSpec } from "./response-observer-types"

/** Anthropic events that never carry usage, a terminal, or an error (Messages streaming spec). */
const ANTHROPIC_CONTENT_EVENTS = new Set([
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "ping",
])
/**
 * The member names that the usage and terminal reads look at (`response-usage.ts`,
 * `response-terminal.ts`). A frame whose text holds none of them cannot move a fact. A key spelled
 * with escapes (`"usage"`) is not seen — only an upstream hiding its own usage would write one.
 */
const MARKERS: Record<Dialect, readonly string[]> = {
  anthropic: ['"usage"', '"error"', '"message_stop"'],
  "openai-chat": ['"usage"', '"error"'],
  "openai-responses": ['"usage"', '"error"', '"response"', '"status"'],
}

/**
 * Which SSE frames the observer may leave unparsed. Parsing is the observer's dominant cost, and
 * most frames of a stream are content deltas. A driver hook or a tap sees every parsed frame, so
 * skipping applies only while no one else needs content frames: no `onPayload` tap, and either no
 * `inspectPayload` hook or a descriptor that declares `contentFrames: "skip"` (read per frame, so a
 * wrapper can stop needing them part-way through a stream).
 */
export function responseFrameSkip(spec: ResponseObservationSpec) {
  const free = () =>
    spec.onPayload === undefined &&
    (spec.descriptor?.inspectPayload === undefined || spec.descriptor.contentFrames === "skip")
  const markers = MARKERS[spec.dialect]
  return {
    event: (name: string) =>
      free() &&
      (spec.dialect === "anthropic"
        ? ANTHROPIC_CONTENT_EVENTS.has(name)
        : spec.dialect === "openai-responses" &&
          name.startsWith("response.") &&
          name.endsWith(".delta")),
    // Only object-shaped text: anything else is parsed so a malformed frame still marks the
    // evidence unavailable.
    data: (text: string) =>
      free() &&
      text.startsWith("{") &&
      text.endsWith("}") &&
      !markers.some((marker) => text.includes(marker)),
  }
}

import { createSseParser, frameJson } from "../sse/parse"

/**
 * A whole Responses SSE stream, folded back into the one Responses object a non-streaming client
 * is owed.
 *
 * Needed only where an upstream answers **only** as a stream (`ResponsesEgressRules.requireStream`)
 * and the client did not ask for one: there is no stream to forward to that client, so reading the
 * upstream to its end delays nothing that could have gone out earlier — the same argument that
 * lets the non-streaming relay read a JSON body whole (`dataplane/relay-translate.ts`).
 *
 * The terminal event (`response.completed`, `.incomplete`, `.failed`) carries the response object.
 * Its `output` is taken as sent when it has items; when it is empty or absent (a terminal snapshot
 * is not obliged to repeat items it already streamed) it is rebuilt from
 * `response.output_item.done`, in `output_index` order. Nothing else is synthesized.
 *
 * Pure: bytes in, an object out. `null` means the stream never reached a terminal event, which a
 * caller reports as the truncation it is rather than translating half an answer.
 */
const TERMINAL = new Set(["response.completed", "response.incomplete", "response.failed"])

export function collectResponsesStream(bytes: Uint8Array): Record<string, unknown> | null {
  const parser = createSseParser()
  const frames = [...parser.push(bytes), ...parser.flush()]
  const items = new Map<number, unknown>()
  let terminal: Record<string, unknown> | null = null

  for (const frame of frames) {
    const event = asRecord(frameJson(frame))
    if (event === null) continue
    const type = typeof event.type === "string" ? event.type : frame.event
    if (type === "response.output_item.done" && typeof event.output_index === "number") {
      items.set(event.output_index, event.item)
    } else if (type !== null && TERMINAL.has(type)) {
      terminal = asRecord(event.response)
    }
  }
  if (terminal === null) return null

  const output = terminal.output
  if (Array.isArray(output) && output.length > 0) return terminal
  const ordered = [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
  return { ...terminal, output: ordered }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

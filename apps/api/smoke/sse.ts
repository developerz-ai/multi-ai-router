/**
 * SSE parser for the streamed `messages.streamed_forced_tool` leg. The wire shape is
 * Anthropic Messages SSE: `event: <name>` lines, `data: <json>` lines, blank lines separating
 * events. The grader reconstructs a final message body from the events; the parser does not.
 *
 * Lenient on whitespace and stray fields — a model that adds an `id:` line in front of `event:`
 * is still parsed. Comment lines (start with `:`) and unknown lines are silently dropped.
 */

import type { StreamEvent } from "./grade"

export function parseSse(text: string): readonly StreamEvent[] {
  const events: StreamEvent[] = []
  let eventName: string | undefined
  let dataLines: string[] = []

  const flush = (): void => {
    if (eventName === undefined && dataLines.length === 0) return
    const dataText = dataLines.join("\n")
    if (eventName !== undefined && dataText.length > 0) {
      events.push({ event: eventName, data: safeJson(dataText) })
    }
    eventName = undefined
    dataLines = []
  }

  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) {
      flush()
      continue
    }
    if (line.startsWith(":")) {
      continue
    }
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim()
      continue
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim())
    }
  }
  flush()
  return events
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

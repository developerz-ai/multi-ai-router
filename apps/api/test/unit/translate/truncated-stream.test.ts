import { describe, expect, test } from "bun:test"
import type { Dialect } from "@multi-ai-router/core"
import { type SseEvent, type SseFrame, translationPair } from "../../../src/services/translate"

/**
 * A translated stream that started and then reached a clean upstream EOF with no terminal event
 * ends with the client dialect's router error event — exactly one, retryable, machine-readable —
 * and never a synthesized finish, `[DONE]` or `message_stop`. Before 2.77.0 it ended on its last
 * content delta and nothing else, which most SDKs read as a finished answer.
 */
const context = { created: 1, model: "m", fallbackId: "req-123", includeUsage: true }

const frame = (payload: Record<string, unknown>, named = true): SseFrame => ({
  event: named ? String(payload.type) : null,
  data: JSON.stringify(payload),
})

const UPSTREAM: Record<Dialect, { started: SseFrame[]; terminal: SseFrame[] }> = {
  "openai-responses": {
    started: [
      frame({ type: "response.created", response: { id: "r", model: "u" } }),
      frame({
        type: "response.output_text.delta",
        item_id: "m1",
        output_index: 0,
        content_index: 0,
        delta: "half",
      }),
    ],
    terminal: [frame({ type: "response.completed", response: { id: "r", status: "completed" } })],
  },
  "openai-chat": {
    started: [frame({ id: "c", choices: [{ index: 0, delta: { content: "half" } }] }, false)],
    terminal: [
      frame({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, false),
      { event: null, data: "[DONE]" },
    ],
  },
  anthropic: {
    started: [
      frame({ type: "message_start", message: { id: "m", model: "u" } }),
      frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half" } }),
    ],
    terminal: [
      frame({ type: "content_block_stop", index: 0 }),
      frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
      frame({ type: "message_stop" }),
    ],
  },
}

const PAIRS: [Dialect, Dialect][] = [
  ["openai-chat", "openai-responses"],
  ["openai-chat", "anthropic"],
  ["anthropic", "openai-responses"],
  ["anthropic", "openai-chat"],
  ["openai-responses", "anthropic"],
  ["openai-responses", "openai-chat"],
]

function stream(ingress: Dialect, egress: Dialect) {
  const pair = translationPair(ingress, egress)
  if (pair === null) throw new Error("no pair")
  return pair.stream(context)
}

/** The router object of an error event, wherever the dialect puts it. */
function routerOf(ingress: Dialect, event: SseEvent | undefined): Record<string, unknown> {
  const payload = JSON.parse(event?.data ?? "{}")
  return ingress === "openai-responses" ? payload.router : payload.error.router
}

const SUCCESS_MARKERS = ['"finish_reason":"', "[DONE]", "message_stop", "response.completed"]

describe("a translated stream truncated at a clean upstream EOF", () => {
  for (const [ingress, egress] of PAIRS) {
    test(`${ingress} client <- ${egress}: one router error event, no synthesized ending`, () => {
      const translator = stream(ingress, egress)
      const sent = UPSTREAM[egress].started.flatMap((f) => translator.push(f))
      expect(sent.length).toBeGreaterThan(0)
      const end = translator.flush()

      expect(end).toHaveLength(1)
      const [event] = end
      for (const marker of SUCCESS_MARKERS) expect(event?.data.includes(marker)).toBe(false)
      if (ingress === "openai-chat") expect(event?.event).toBeUndefined()
      else expect(event?.event).toBe("error")

      const router = routerOf(ingress, event)
      expect(router).toMatchObject({
        wall: "capacity",
        scope: "account",
        retryable: true,
        signal: "upstream_incomplete",
        request_id: "req-123",
      })
      const payload = JSON.parse(event?.data ?? "{}")
      if (ingress === "anthropic") expect(payload.type).toBe("error")
      if (ingress === "openai-chat") expect(payload.error.code).toBe("upstream_incomplete")
      if (ingress === "openai-responses") {
        expect(payload).toMatchObject({ type: "error", code: "upstream_incomplete", param: null })
      }

      expect(translator.truncated?.()).toBe(true)
      // Idempotent: a second flush, or a late frame, adds nothing after the error.
      expect(translator.flush()).toEqual([])
      expect(UPSTREAM[egress].terminal.flatMap((f) => translator.push(f))).toEqual([])
    })

    test(`${ingress} client <- ${egress}: a stream that never started owes nothing`, () => {
      const translator = stream(ingress, egress)
      expect(translator.flush()).toEqual([])
      expect(translator.truncated?.()).toBe(false)
    })

    test(`${ingress} client <- ${egress}: a finished stream gets no error event`, () => {
      const translator = stream(ingress, egress)
      const all = [...UPSTREAM[egress].started, ...UPSTREAM[egress].terminal]
      const events = [...all.flatMap((f) => translator.push(f)), ...translator.flush()]
      expect(events.some((event) => event.data.includes("upstream_incomplete"))).toBe(false)
      expect(translator.truncated?.()).toBe(false)
    })
  }

  test("an in-stream upstream error is the only error event: flush adds no second one", () => {
    const translator = stream("openai-chat", "openai-responses")
    const events = [
      ...UPSTREAM["openai-responses"].started,
      frame({ type: "error", code: "server_is_overloaded", message: "overloaded" }),
    ].flatMap((f) => translator.push(f))
    expect(events.filter((event) => event.data.includes('"error"'))).toHaveLength(1)
    expect(translator.flush()).toEqual([])
    expect(translator.truncated?.()).toBe(false)
  })

  /**
   * dz review of #504: Anthropic's `message_stop` with no `message_delta` before it states no stop
   * reason. After partial output the chat client got `[DONE]` with no `finish_reason` chunk, a
   * terminator over an answer nobody called finished.
   */
  test("anthropic `message_stop` with no `message_delta`: the truncation event, never a bare `[DONE]`", () => {
    const stop = frame({ type: "message_stop" })
    const chat = stream("openai-chat", "anthropic")
    for (const f of UPSTREAM.anthropic.started) chat.push(f)
    const ended = [...chat.push(stop), ...chat.flush()]
    expect(ended).toHaveLength(1)
    expect(ended.some((event) => event.data === "[DONE]")).toBe(false)
    expect(routerOf("openai-chat", ended[0])).toMatchObject({ signal: "upstream_incomplete" })
    expect(chat.truncated?.()).toBe(true)
    expect(chat.push(frame({ type: "message_delta", delta: { stop_reason: "end_turn" } }))).toEqual(
      [],
    )

    // The Responses client of the same upstream: nothing on `message_stop`, the one event at EOF.
    const responses = stream("openai-responses", "anthropic")
    for (const f of UPSTREAM.anthropic.started) responses.push(f)
    expect(responses.push(stop)).toEqual([])
    const end = responses.flush()
    expect(end).toHaveLength(1)
    expect(end[0]?.data.includes("response.completed")).toBe(false)
    expect(responses.truncated?.()).toBe(true)
  })

  test("anthropic `message_stop` as the very first event owes nothing: no `[DONE]` over silence", () => {
    const chat = stream("openai-chat", "anthropic")
    expect([...chat.push(frame({ type: "message_stop" })), ...chat.flush()]).toEqual([])
    expect(chat.truncated?.()).toBe(false)
  })

  test("a terminal is emitted only with a stated finish, in every translator", () => {
    for (const [ingress, egress] of PAIRS) {
      const translator = stream(ingress, egress)
      const events = [
        ...UPSTREAM[egress].started.flatMap((f) => translator.push(f)),
        ...(egress === "anthropic" ? translator.push(frame({ type: "message_stop" })) : []),
      ]
      const text = events.map((event) => `${event.event ?? ""} ${event.data}`).join("\n")
      for (const marker of ["[DONE]", "message_stop", "response.completed"]) {
        expect(text.includes(marker), `${ingress} <- ${egress}: ${marker}`).toBe(false)
      }
    }
  })

  test("a finish reason with no `[DONE]` is a whole completion, not a truncation", () => {
    const translator = stream("anthropic", "openai-chat")
    const [finish] = UPSTREAM["openai-chat"].terminal
    if (finish === undefined) throw new Error("fixture")
    for (const f of [...UPSTREAM["openai-chat"].started, finish]) translator.push(f)
    const end = translator.flush()
    expect(end.at(-1)?.event).toBe("message_stop")
    expect(translator.truncated?.()).toBe(false)
  })
})

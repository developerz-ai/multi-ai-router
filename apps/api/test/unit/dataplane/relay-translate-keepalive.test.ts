import { describe, expect, test } from "bun:test"
import { relayTranslatedResponse } from "../../../src/services/dataplane/relay-translate"
import type { TranslationContext } from "../../../src/services/translate"
import { translationPair } from "../../../src/services/translate/registry"

/**
 * **A translated stream can be silent while the upstream is loud, and that used to cost the turn.**
 *
 * `thinking` and `redacted_thinking` deltas have no openai-chat counterpart and are documented as
 * dropped. An extended-thinking model spends its opening stretch emitting nothing else — so the
 * upstream stream is busy, the translated stream writes zero bytes, and the client's connection sits
 * idle through the whole thinking phase until something under it gives up.
 *
 * Measured in-cluster on 2026-09-06, one prompt against one account, back to back:
 * `/v1/chat/completions` received 210 bytes and the socket closed at 11.9 s, while `/v1/messages` —
 * the byte relay, no translation — carried 20,469 bytes of the same answer and was still streaming
 * when the probe's own 22 s cap stopped it. Same account, same model, same moment; the only
 * difference was the translation.
 *
 * The clock is injected, so these assert the rule rather than waiting for it.
 */

const CONTEXT: TranslationContext = {
  created: 1_700_000_000,
  model: "default",
  fallbackId: "chatcmpl_test",
  openAiChatCeiling: { defaultMaxTokens: 4_096 },
}

const PAIR = translationPair("openai-chat", "anthropic")

/** An Anthropic SSE frame, as the upstream writes it. */
function frame(name: string, payload: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify({ type: name, ...payload })}\n\n`
}

const MESSAGE_START = frame("message_start", {
  message: { id: "msg_1", model: "claude-opus-5", usage: {} },
})

const THINKING_START = frame("content_block_start", {
  index: 0,
  content_block: { type: "thinking", thinking: "" },
})

function thinkingDelta(text: string): string {
  return frame("content_block_delta", {
    index: 0,
    delta: { type: "thinking_delta", thinking: text },
  })
}

/** A clock the test advances by hand, and a stream whose chunks it steps between. */
function relayed(chunks: readonly string[], stepMs: number, keepaliveMs = 5_000) {
  let clock = 0
  const encoder = new TextEncoder()
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          clock += stepMs
          controller.enqueue(encoder.encode(chunk))
          // Let the transform run before the clock moves again.
          await Promise.resolve()
        }
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

  if (PAIR === null) throw new Error("openai-chat ← anthropic has no translation pair")
  return relayTranslatedResponse({
    upstream,
    pair: PAIR,
    context: CONTEXT,
    keepaliveMs,
    now: () => clock,
  })
}

/** SSE comment lines — a colon, no event, no data. */
function comments(sse: string): number {
  return sse.split("\n").filter((line) => line.startsWith(":")).length
}

function dataLines(sse: string): number {
  return sse.split("\n").filter((line) => line.startsWith("data: ")).length
}

describe("an upstream that is thinking, which translates to nothing", () => {
  const thinking = [
    MESSAGE_START,
    THINKING_START,
    ...Array.from({ length: 6 }, () => thinkingDelta("…")),
  ]

  test("the client still gets bytes, so nothing under it decides the connection is dead", async () => {
    const sse = await relayed(thinking, 4_000).text()

    expect(comments(sse)).toBeGreaterThan(0)
    // And they are comments, not content: a thinking delta has no openai-chat counterpart and must
    // not acquire one just because the connection needed a byte.
    expect(sse).not.toContain("thinking")
  })

  test("the content the client is owed still arrives, and the comments are not it", async () => {
    const sse = await relayed(thinking, 4_000).text()

    // Exactly one data line: `message_start`'s opening chunk. Every dropped frame stays dropped.
    expect(dataLines(sse)).toBe(1)
  })

  test("a stream that is never quiet for long enough sends none at all", async () => {
    const sse = await relayed(thinking, 100).text()

    expect(comments(sse)).toBe(0)
  })
})

describe("a stream that is producing output", () => {
  const answering = [
    MESSAGE_START,
    frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ...Array.from({ length: 4 }, () =>
      frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
    ),
  ]

  test("pays nothing while it is answering: the quiet window never opens", async () => {
    const sse = await relayed(answering, 1_000).text()

    expect(comments(sse)).toBe(0)
    expect(dataLines(sse)).toBe(5)
  })

  test("but a long enough gap between two written chunks still earns one", async () => {
    // The rule is about silence toward the *client*, not about what kind of frame caused it: an
    // upstream that pauses ten seconds between two text deltas is the same connection risk.
    const sse = await relayed(answering, 9_000).text()

    expect(comments(sse)).toBeGreaterThan(0)
    expect(dataLines(sse)).toBe(5)
  })
})

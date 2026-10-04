import { describe, expect, test } from "bun:test"
import { CODEX_RESPONSES_EGRESS, httpDriver } from "../../../src/providers"
import {
  collectResponsesStream,
  DEFAULT_RESPONSES_EGRESS,
  type TranslationContext,
  type TranslationDrop,
  translationPair,
} from "../../../src/services/translate"

/**
 * Production, 2026-10-04: a ChatGPT (Codex) account reached by `/v1/messages` or
 * `/v1/chat/completions` was sent the standard Responses body — `max_output_tokens`, `temperature`,
 * the client's `stream`, no `instructions` — which the Codex backend refuses outright. The surface's
 * rules come from its driver; the translator applies them and stays pure.
 */
function context(overrides: Partial<TranslationContext> = {}): TranslationContext {
  return { created: 1, model: "gpt-5.5", fallbackId: "req-1", ...overrides }
}

function sent(
  ingress: "anthropic" | "openai-chat",
  body: unknown,
  rules = CODEX_RESPONSES_EGRESS,
): { body: Record<string, unknown>; drops: TranslationDrop[] } {
  const pair = translationPair(ingress, "openai-responses")
  if (pair === null) throw new Error("no pair")
  const drops: TranslationDrop[] = []
  const out = pair.request(body, context({ responsesEgress: rules, onDrop: (d) => drops.push(d) }))
  return { body: out as Record<string, unknown>, drops }
}

const ANTHROPIC = {
  model: "gpt-5.5",
  max_tokens: 1024,
  temperature: 0.2,
  top_p: 0.9,
  messages: [{ role: "user", content: "hi" }],
}

const CHAT = {
  model: "gpt-5.5",
  max_completion_tokens: 512,
  temperature: 0.3,
  top_p: 0.8,
  messages: [{ role: "user", content: "hi" }],
}

describe("a Codex-ruled Responses surface", () => {
  test("anthropic ingress: refused params are gone, stream forced, instructions present", () => {
    const { body, drops } = sent("anthropic", ANTHROPIC)
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.stream).toBe(true)
    expect(body.instructions).toBe("")
    expect(body.store).toBe(false)
    expect(drops.map((d) => d.field).sort()).toEqual(["max_output_tokens", "temperature", "top_p"])
    expect(JSON.stringify(drops)).not.toContain("1024")
  })

  test("a system prompt still becomes the instructions", () => {
    const { body } = sent("anthropic", { ...ANTHROPIC, system: "be terse", stream: false })
    expect(body.instructions).toBe("be terse")
    expect(body.stream).toBe(true)
  })

  test("chat ingress gets the same treatment", () => {
    const { body } = sent("openai-chat", CHAT)
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.stream).toBe(true)
    expect(body.instructions).toBe("")
    expect(body.store).toBe(false)
  })

  test("an ordinary Responses surface is untouched by any of it", () => {
    const { body, drops } = sent("anthropic", ANTHROPIC, DEFAULT_RESPONSES_EGRESS)
    expect(body.max_output_tokens).toBe(1024)
    expect(body.temperature).toBe(0.2)
    expect(body.stream).toBeUndefined()
    expect(body.instructions).toBeUndefined()
    expect(drops).toHaveLength(0)
    const absent = translationPair("anthropic", "openai-responses")?.request(ANTHROPIC, context())
    expect((absent as Record<string, unknown>).max_output_tokens).toBe(1024)
  })
})

function sse(events: ReadonlyArray<readonly [string, unknown]>): Uint8Array {
  return new TextEncoder().encode(
    events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
  )
}

const MESSAGE = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "hello", annotations: [] }],
}

describe("collecting a forced stream for a client that did not ask for one", () => {
  test("the completed response is the body, its empty output filled from the done items", () => {
    const collected = collectResponsesStream(
      sse([
        ["response.created", { type: "response.created", response: { id: "resp_1" } }],
        [
          "response.output_item.done",
          { type: "response.output_item.done", output_index: 0, item: MESSAGE },
        ],
        [
          "response.completed",
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              object: "response",
              status: "completed",
              model: "gpt-5.5",
              output: [],
              usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
            },
          },
        ],
      ]),
    ) as Record<string, unknown>
    expect(collected.id).toBe("resp_1")
    expect(collected.output).toEqual([MESSAGE])
    expect(collected.usage).toEqual({ input_tokens: 3, output_tokens: 1, total_tokens: 4 })

    const pair = translationPair("anthropic", "openai-responses")
    const client = pair?.response(collected, context()).body as Record<string, unknown>
    expect(client.content).toEqual([{ type: "text", text: "hello" }])
  })

  test("a terminal snapshot that already carries its output is kept as sent", () => {
    const other = { ...MESSAGE, id: "msg_2" }
    const collected = collectResponsesStream(
      sse([
        [
          "response.output_item.done",
          { type: "response.output_item.done", output_index: 0, item: MESSAGE },
        ],
        [
          "response.completed",
          { type: "response.completed", response: { id: "r", output: [other] } },
        ],
      ]),
    ) as Record<string, unknown>
    expect(collected.output).toEqual([other])
  })

  test("a stream that never reached a terminal event yields nothing to translate", () => {
    expect(
      collectResponsesStream(
        sse([
          [
            "response.output_item.done",
            { type: "response.output_item.done", output_index: 0, item: MESSAGE },
          ],
        ]),
      ),
    ).toBeNull()
  })

  test("a failed response is returned as the upstream stated it", () => {
    const failed = { id: "r", status: "failed", error: { code: "server_error", message: "boom" } }
    expect(
      collectResponsesStream(
        sse([["response.failed", { type: "response.failed", response: failed }]]),
      ),
    ).toEqual({ ...failed, output: [] })
  })
})

describe("the rules come from the driver", () => {
  test("the Codex surface declares them; an ordinary Responses surface answers the default", () => {
    const codex = httpDriver("openai-oauth")
    const openai = httpDriver("openai-api")
    if (codex === null || openai === null) throw new Error("missing driver")
    const at = (provider: "openai-oauth" | "openai-api") => ({
      id: "a",
      provider,
      dialect: "openai-responses" as const,
    })
    expect(codex.resolveResponsesEgress(at("openai-oauth"))).toBe(CODEX_RESPONSES_EGRESS)
    expect(openai.resolveResponsesEgress(at("openai-api"))).toBe(DEFAULT_RESPONSES_EGRESS)
  })
})

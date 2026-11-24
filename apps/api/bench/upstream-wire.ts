import type { Dialect } from "@multi-ai-router/core"
import { responsesBody, responsesStreamChunks } from "./upstream-responses"

/**
 * What the stub upstream says, in each wire it can speak: the non-streamed answer and the SSE
 * chunks. `upstream.ts` owns when they are sent; this file owns their bytes. Every text delta is
 * `tok<N> `, which is how the driver matches a token at the client to its release at the stub.
 */

/** What the account speaks. `anthropic` is passthrough; the other two are translated. */
export type StubDialect = Extract<Dialect, "anthropic" | "openai-chat" | "openai-responses">

const MODEL = "claude-opus-5"
const UPSTREAM_MODEL = "gpt-4o"
const TOKENS_IN = 24
const TOKENS_OUT = 32

/** Answer text with an escape every line, the shape a model's code answer has on the wire. */
function answerText(bytes: number | undefined): string {
  if (bytes === undefined) return "bench"
  const line = 'const value = "bench"\n'
  return line.repeat(Math.max(1, Math.ceil(bytes / line.length)))
}

export function stubBody(dialect: StubDialect, answerBytes?: number): unknown {
  const text = answerText(answerBytes)
  if (dialect === "openai-responses") {
    return responsesBody(text, { input_tokens: TOKENS_IN, output_tokens: TOKENS_OUT })
  }
  if (dialect === "anthropic") {
    return {
      id: "msg_bench",
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: TOKENS_IN, output_tokens: TOKENS_OUT },
    }
  }
  return {
    id: "chatcmpl-bench",
    object: "chat.completion",
    model: UPSTREAM_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: TOKENS_IN, completion_tokens: TOKENS_OUT },
  }
}

export function streamChunks(dialect: StubDialect, count: number): readonly string[] {
  if (dialect === "openai-responses") {
    return responsesStreamChunks(count, { input_tokens: TOKENS_IN, output_tokens: TOKENS_OUT })
  }
  const deltas = Array.from({ length: Math.max(1, count) }, (_unused, index) =>
    dialect === "anthropic" ? anthropicDelta(index) : openAiDelta(index),
  )
  return dialect === "anthropic"
    ? [anthropicStart(), ...deltas, anthropicEnd()]
    : [...deltas, openAiEnd()]
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

function anthropicStart(): string {
  return (
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_bench",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        usage: { input_tokens: TOKENS_IN, output_tokens: 0 },
      },
    }) +
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })
  )
}

function anthropicDelta(index: number): string {
  return event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: `tok${index} ` },
  })
}

function anthropicEnd(): string {
  return (
    event("content_block_stop", { type: "content_block_stop", index: 0 }) +
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: TOKENS_OUT },
    }) +
    event("message_stop", { type: "message_stop" })
  )
}

function openAiChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-bench", object: "chat.completion.chunk", model: UPSTREAM_MODEL, ...payload })}\n\n`
}

function openAiDelta(index: number): string {
  const delta = index === 0 ? { role: "assistant", content: "tok0 " } : { content: `tok${index} ` }
  return openAiChunk({ choices: [{ index: 0, delta }] })
}

function openAiEnd(): string {
  return (
    openAiChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
    openAiChunk({
      choices: [],
      usage: { prompt_tokens: TOKENS_IN, completion_tokens: TOKENS_OUT },
    }) +
    "data: [DONE]\n\n"
  )
}

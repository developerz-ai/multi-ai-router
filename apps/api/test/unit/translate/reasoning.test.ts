/**
 * Reasoning, and the two dials that travel with it, across every seam that states them on both
 * sides (docs/idea/06-protocol-translation.md#known-lossy-edges).
 *
 * Three separate facts, gathered here because they are one story and they were one bug:
 *
 * - **the request dial** — openai-chat's `reasoning_effort` is openai-responses' `reasoning.effort`
 *   one level flatter, so it survives that pair in both directions, and Anthropic's
 *   `output_config.effort` is the same dial again;
 * - **the response text** — a reasoning model reached over openai-chat streams its thinking under a
 *   name OpenAI never published, and Responses has an item type waiting for it;
 * - **`parallel_tool_calls`** — spelled identically by both OpenAI dialects, dropped by neither.
 *
 * Each carried case asserts the value *arrives*; each dropped case asserts it is **absent**, not
 * approximated, because a drop nobody can see is the failure mode this file exists to catch.
 */

import { describe, expect, test } from "bun:test"
import {
  anthropicToOpenAiChatRequest,
  openAiChatToAnthropicRequest,
  openAiChatToAnthropicResponse,
  openAiChatToAnthropicStream,
  openAiChatToOpenAiResponsesRequest,
  openAiChatToOpenAiResponsesResponse,
  openAiChatToOpenAiResponsesStream,
  openAiResponsesToAnthropicRequest,
  openAiResponsesToOpenAiChatRequest,
} from "../../../src/services/translate"
import { ROUTER_THINKING_SIGNATURE } from "../../../src/services/translate/shared/router-thinking"
import { openAiChatChunk, openAiChatRequest, openAiResponsesRequest, payloads } from "./fixtures"

const CREATED = 1_700_000_000

/** A `chat.completion` object as a reasoning-model upstream answers it, non-streaming. */
function completion(message: Record<string, unknown>): unknown {
  return {
    id: "chatcmpl-1",
    model: "deepseek-reasoner",
    choices: [{ index: 0, message, finish_reason: "stop" }],
  }
}

interface WireItem {
  readonly type: string
  /** A reasoning item states its text as `summary[].text` on the wire, never as a bare string. */
  readonly summary?: readonly { readonly text?: string }[]
}

function responsesItems(body: unknown): WireItem[] {
  const output = (body as { output?: unknown }).output
  return Array.isArray(output) ? (output as WireItem[]) : []
}

function summaryText(body: unknown): string | undefined {
  return responsesItems(body).find((item) => item.type === "reasoning")?.summary?.[0]?.text
}

describe("reasoning_effort <-> reasoning.effort", () => {
  test("openai-chat -> openai-responses nests the effort word, unchanged", () => {
    const out = openAiChatToOpenAiResponsesRequest(openAiChatRequest({ reasoning_effort: "high" }))
    expect(out.reasoning).toEqual({ effort: "high" })
  })

  /**
   * The vocabulary belongs to the provider and it grows: OpenAI's published set reached
   * `none | minimal | low | medium | high | xhigh | max` in two steps past the four everyone
   * remembers. A translator that validated the word would refuse a dial the upstream accepts, which
   * is the router deciding how the model behaves rather than the client.
   */
  test("an effort word this build has never seen travels verbatim", () => {
    for (const effort of ["none", "xhigh", "max", "ultra-thorough"]) {
      const out = openAiChatToOpenAiResponsesRequest(
        openAiChatRequest({ reasoning_effort: effort }),
      )
      expect(out.reasoning).toEqual({ effort })
    }
  })

  test("openai-responses -> openai-chat flattens it back", () => {
    const out = openAiResponsesToOpenAiChatRequest(
      openAiResponsesRequest({ reasoning: { effort: "low" } }),
    )
    expect(out.reasoning_effort).toBe("low")
  })

  test("a round trip through both translators returns the caller's own word", () => {
    const nested = openAiChatToOpenAiResponsesRequest(
      openAiChatRequest({ reasoning_effort: "medium" }),
    )
    const flat = openAiResponsesToOpenAiChatRequest(
      openAiResponsesRequest({ reasoning: nested.reasoning }),
    )
    expect(flat.reasoning_effort).toBe("medium")
  })

  test("an absent dial stays absent in both directions: no default is invented", () => {
    expect(openAiChatToOpenAiResponsesRequest(openAiChatRequest()).reasoning).toBeUndefined()
    expect(
      openAiResponsesToOpenAiChatRequest(openAiResponsesRequest()).reasoning_effort,
    ).toBeUndefined()
  })

  /**
   * `reasoning.summary` asks the *provider* to write a summary of its own reasoning. openai-chat has
   * no way to ask for one, so it is dropped — and the effort beside it still travels.
   */
  test("reasoning.summary is dropped while effort survives", () => {
    const out = openAiResponsesToOpenAiChatRequest(
      openAiResponsesRequest({ reasoning: { effort: "high", summary: "detailed" } }),
    )
    expect(out.reasoning_effort).toBe("high")
    expect(JSON.stringify(out)).not.toContain("detailed")
  })

  /**
   * Anthropic states the same dial as `output_config.effort`, so it is carried from either OpenAI
   * dialect (`reasoning-crossing.test.ts` covers the clamps and the reverse direction).
   */
  test("toward anthropic it becomes output_config.effort, from either OpenAI dialect", () => {
    const fromChat = openAiChatToAnthropicRequest(openAiChatRequest({ reasoning_effort: "high" }))
    const fromResponses = openAiResponsesToAnthropicRequest(
      openAiResponsesRequest({ reasoning: { effort: "high" } }),
    )
    for (const body of [fromChat, fromResponses]) {
      expect(body.output_config).toEqual({ effort: "high" })
    }
  })
})

describe("parallel_tool_calls", () => {
  test("openai-chat -> openai-responses carries it: both dialects state the same field", () => {
    expect(
      openAiChatToOpenAiResponsesRequest(openAiChatRequest({ parallel_tool_calls: false }))
        .parallel_tool_calls,
    ).toBe(false)
    expect(
      openAiChatToOpenAiResponsesRequest(openAiChatRequest({ parallel_tool_calls: true }))
        .parallel_tool_calls,
    ).toBe(true)
  })

  test("openai-responses -> openai-chat carries it back", () => {
    expect(
      openAiResponsesToOpenAiChatRequest(openAiResponsesRequest({ parallel_tool_calls: false }))
        .parallel_tool_calls,
    ).toBe(false)
  })

  /** `false` is the value that changes behaviour, so an absent field must not become one. */
  test("an absent field stays absent rather than defaulting to either value", () => {
    expect(
      openAiChatToOpenAiResponsesRequest(openAiChatRequest()).parallel_tool_calls,
    ).toBeUndefined()
    expect(
      openAiResponsesToOpenAiChatRequest(openAiResponsesRequest()).parallel_tool_calls,
    ).toBeUndefined()
  })

  /** Anthropic serial policy lives inside `tool_choice`, preserving the caller contract. */
  test("toward anthropic it becomes an explicit serial tool policy", () => {
    const body = openAiChatToAnthropicRequest(
      openAiChatRequest({
        parallel_tool_calls: false,
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      }),
    )
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true })
  })
})

describe("openai-chat reasoning text -> an openai-responses reasoning item", () => {
  test("reasoning_content becomes a reasoning item, ahead of the answer", () => {
    const out = openAiChatToOpenAiResponsesResponse(
      completion({ content: "42", reasoning_content: "the user wants a number" }),
      { created: CREATED },
    )
    expect(responsesItems(out.body).map((item) => item.type)).toEqual(["reasoning", "message"])
    expect(summaryText(out.body)).toBe("the user wants a number")
  })

  /** OpenRouter's spelling of the same field. A router reading one name loses every model on the other. */
  test("the `reasoning` spelling is read too", () => {
    const out = openAiChatToOpenAiResponsesResponse(
      completion({ content: "42", reasoning: "thinking out loud" }),
      { created: CREATED },
    )
    expect(summaryText(out.body)).toBe("thinking out loud")
  })

  test("an upstream stating both names is carried once, not twice", () => {
    const out = openAiChatToOpenAiResponsesResponse(
      completion({ content: "42", reasoning_content: "once", reasoning: "once" }),
      { created: CREATED },
    )
    expect(responsesItems(out.body).filter((item) => item.type === "reasoning")).toHaveLength(1)
    expect(summaryText(out.body)).toBe("once")
  })

  test("a completion with no reasoning opens no item", () => {
    const out = openAiChatToOpenAiResponsesResponse(completion({ content: "42" }), {
      created: CREATED,
    })
    expect(responsesItems(out.body).map((item) => item.type)).toEqual(["message"])
  })

  test("a streamed reasoning delta becomes response.reasoning_summary_text.delta", () => {
    const stream = openAiChatToOpenAiResponsesStream({ created: CREATED, id: "fallback" })
    const events = stream.push(openAiChatChunk({ reasoning_content: "step one" }))
    const delta = payloads(events).find(
      (event) => (event as { type: string }).type === "response.reasoning_summary_text.delta",
    ) as { delta?: string } | undefined
    expect(delta?.delta).toBe("step one")
  })

  test("the streamed `reasoning` spelling is read too", () => {
    const stream = openAiChatToOpenAiResponsesStream({ created: CREATED, id: "fallback" })
    const events = stream.push(openAiChatChunk({ reasoning: "step one" }))
    expect(events.map((event) => event.event)).toContain("response.reasoning_summary_text.delta")
  })

  /**
   * The item boundary is the whole point of the Responses shape: thinking is one item and the answer
   * is another, so the reasoning item must be `done` before the message item is `added`.
   */
  test("the reasoning item closes before the answer's item opens", () => {
    const stream = openAiChatToOpenAiResponsesStream({ created: CREATED, id: "fallback" })
    const events = [
      ...stream.push(openAiChatChunk({ reasoning_content: "hmm" })),
      ...stream.push(openAiChatChunk({ content: "42" })),
    ]
    const names = events.map((event) => event.event)
    const reasoningDone = names.indexOf("response.reasoning_summary_text.done")
    const textDelta = names.indexOf("response.output_text.delta")
    expect(reasoningDone).toBeGreaterThanOrEqual(0)
    expect(textDelta).toBeGreaterThan(reasoningDone)
  })

  test("reasoning arriving with no answer still completes as its own item", () => {
    const stream = openAiChatToOpenAiResponsesStream({ created: CREATED, id: "fallback" })
    const events = [
      ...stream.push(openAiChatChunk({ reasoning_content: "hmm" })),
      ...stream.push(
        openAiChatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      ),
      ...stream.push({ event: null, data: "[DONE]" }),
    ]
    const completed = payloads(events).find(
      (event) => (event as { type: string }).type === "response.completed",
    ) as { response?: { output?: { type: string; summary?: unknown }[] } } | undefined
    expect(completed?.response?.output?.map((item) => item.type)).toEqual(["reasoning"])
  })
})

/**
 * Toward `anthropic` the text becomes a `thinking` block signed with the router's tag, the same
 * treatment a Responses reasoning summary gets (`router-thinking.ts`,
 * `06-protocol-translation.md#known-lossy-edges`). It used to be dropped, and the drop was the bug:
 * prod 2026-10-18, `qwen3.8-max` over `/v1/messages` thought for 341 s, and the translated stream
 * carried `message_start`, then nothing but SSE comments until the answer. A comment is no event in
 * any client, so an Anthropic SDK reader saw no stream part for minutes and its caller's silence
 * policy abandoned the request — 20 such streams on one account in three days, each billed and
 * thrown away. Replayed on the next turn, every `anthropic -> X` translator drops the block again,
 * so the tag never reaches a non-Anthropic upstream.
 */
describe("openai-chat reasoning text -> anthropic: a router-signed thinking block", () => {
  test("a non-streaming reasoning_content becomes a signed thinking block ahead of the answer", () => {
    const out = openAiChatToAnthropicResponse(
      completion({ content: "42", reasoning_content: "the user wants a number" }),
    )
    const blocks = (out.body as { content: Record<string, unknown>[] }).content
    expect(blocks).toEqual([
      {
        type: "thinking",
        thinking: "the user wants a number",
        signature: ROUTER_THINKING_SIGNATURE,
      },
      { type: "text", text: "42" },
    ])
  })

  test("the non-streaming `reasoning` spelling is read too, and an empty one opens no block", () => {
    const spelled = openAiChatToAnthropicResponse(completion({ content: "42", reasoning: "hmm" }))
    expect((spelled.body as { content: { type: string }[] }).content.map((b) => b.type)).toEqual([
      "thinking",
      "text",
    ])
    const none = openAiChatToAnthropicResponse(completion({ content: "42", reasoning_content: "" }))
    expect((none.body as { content: { type: string }[] }).content.map((b) => b.type)).toEqual([
      "text",
    ])
  })

  test("a thinking phase is visible to the client: each reasoning delta is a thinking_delta", () => {
    // The prod fingerprint: a long run of reasoning-only chunks before any answer.
    const stream = openAiChatToAnthropicStream({ id: "fallback" })
    const thinking = [
      ...stream.push(openAiChatChunk({ reasoning_content: "step one" })),
      ...stream.push(openAiChatChunk({ reasoning_content: ", step two" })),
    ]
    const deltas = payloads(thinking).filter(
      (event) => (event as { type: string }).type === "content_block_delta",
    ) as { delta: { type: string; thinking?: string } }[]
    expect(deltas.map((event) => event.delta)).toEqual([
      { type: "thinking_delta", thinking: "step one" },
      { type: "thinking_delta", thinking: ", step two" },
    ])
    const starts = payloads(thinking).filter(
      (event) => (event as { type: string }).type === "content_block_start",
    ) as { content_block: { type: string } }[]
    expect(starts.map((event) => event.content_block.type)).toEqual(["thinking"])
  })

  test("the thinking block is signed and closed before the answer's text block opens", () => {
    const stream = openAiChatToAnthropicStream({ id: "fallback" })
    const events = [
      ...stream.push(openAiChatChunk({ reasoning: "hmm" })),
      ...stream.push(openAiChatChunk({ content: "42" })),
    ]
    const shapes = payloads(events).map((event) => {
      const e = event as {
        type: string
        delta?: { type: string }
        content_block?: { type: string }
      }
      return [e.type, e.delta?.type ?? e.content_block?.type ?? null]
    })
    expect(shapes).toEqual([
      ["message_start", null],
      ["content_block_start", "thinking"],
      ["content_block_delta", "thinking_delta"],
      ["content_block_delta", "signature_delta"],
      ["content_block_stop", null],
      ["content_block_start", "text"],
      ["content_block_delta", "text_delta"],
    ])
    const signature = payloads(events).find(
      (event) => (event as { delta?: { type: string } }).delta?.type === "signature_delta",
    ) as { delta: { signature: string } }
    expect(signature.delta.signature).toBe(ROUTER_THINKING_SIGNATURE)
  })

  test("an upstream stating both names is carried once, not twice", () => {
    const stream = openAiChatToAnthropicStream({ id: "fallback" })
    const events = stream.push(openAiChatChunk({ reasoning_content: "once", reasoning: "once" }))
    expect(JSON.stringify(payloads(events)).match(/once/g)).toHaveLength(1)
  })

  test("the signed block replayed toward openai-chat is dropped again", () => {
    const out = anthropicToOpenAiChatRequest({
      model: "qwen3.8-max",
      max_tokens: 64,
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private chain", signature: ROUTER_THINKING_SIGNATURE },
            { type: "text", text: "42" },
          ],
        },
        { role: "user", content: "and?" },
      ],
    })
    expect(JSON.stringify(out)).not.toContain("private chain")
    expect(JSON.stringify(out)).not.toContain(ROUTER_THINKING_SIGNATURE)
  })
})

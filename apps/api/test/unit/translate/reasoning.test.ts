/**
 * Reasoning, and the two dials that travel with it, across every seam that states them on both
 * sides (docs/idea/06-protocol-translation.md#known-lossy-edges).
 *
 * Three separate facts, gathered here because they are one story and they were one bug:
 *
 * - **the request dial** — openai-chat's `reasoning_effort` is openai-responses' `reasoning.effort`
 *   one level flatter, so it survives that pair in both directions and is a documented drop toward
 *   `anthropic`, whose extended thinking is a token budget rather than an effort word;
 * - **the response text** — a reasoning model reached over openai-chat streams its thinking under a
 *   name OpenAI never published, and Responses has an item type waiting for it;
 * - **`parallel_tool_calls`** — spelled identically by both OpenAI dialects, dropped by neither.
 *
 * Each carried case asserts the value *arrives*; each dropped case asserts it is **absent**, not
 * approximated, because a drop nobody can see is the failure mode this file exists to catch.
 */

import { describe, expect, test } from "bun:test"
import {
  openAiChatToAnthropicRequest,
  openAiChatToAnthropicResponse,
  openAiChatToAnthropicStream,
  openAiChatToOpenAiResponsesRequest,
  openAiChatToOpenAiResponsesResponse,
  openAiChatToOpenAiResponsesStream,
  openAiResponsesToAnthropicRequest,
  openAiResponsesToOpenAiChatRequest,
} from "../../../src/services/translate"
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
   * Anthropic states extended thinking as a **token budget**. Turning `"high"` into one would invent
   * both what the caller pays and how long the answer takes, so both directions drop it — the loss
   * cannot depend on which way the request happened to point.
   */
  test("toward anthropic it is dropped, from either OpenAI dialect", () => {
    const fromChat = openAiChatToAnthropicRequest(openAiChatRequest({ reasoning_effort: "high" }))
    const fromResponses = openAiResponsesToAnthropicRequest(
      openAiResponsesRequest({ reasoning: { effort: "high" } }),
    )
    for (const body of [fromChat, fromResponses]) {
      expect(JSON.stringify(body)).not.toContain("effort")
      expect(JSON.stringify(body)).not.toContain("thinking")
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

  /** Anthropic spells it inside `tool_choice`, on a field this build does not emit. */
  test("toward anthropic it is dropped, as documented", () => {
    const body = openAiChatToAnthropicRequest(openAiChatRequest({ parallel_tool_calls: false }))
    expect(JSON.stringify(body)).not.toContain("parallel")
    expect(JSON.stringify(body)).not.toContain("disable_parallel_tool_use")
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
 * Anthropic states a `thinking` block that would hold this text, and it is still dropped.
 *
 * A client is entitled to replay an assistant turn verbatim on its next request, and Anthropic
 * refuses a `thinking` block whose `signature` this router cannot produce. An unsigned block would
 * answer this turn and break the next one — the same reason a Responses `reasoning` item is dropped
 * toward `anthropic` (`06-protocol-translation.md#known-lossy-edges`).
 */
describe("openai-chat reasoning text -> anthropic: a documented drop", () => {
  test("a non-streaming reasoning_content emits no thinking block", () => {
    const out = openAiChatToAnthropicResponse(
      completion({ content: "42", reasoning_content: "the user wants a number" }),
    )
    const blocks = (out.body as { content: { type: string }[] }).content
    expect(blocks.map((block) => block.type)).toEqual(["text"])
    expect(JSON.stringify(out.body)).not.toContain("the user wants a number")
  })

  test("a streamed reasoning delta emits no block and no delta", () => {
    const stream = openAiChatToAnthropicStream({ id: "fallback" })
    const events = [
      ...stream.push(openAiChatChunk({ reasoning_content: "hmm" })),
      ...stream.push(openAiChatChunk({ content: "42" })),
    ]
    const serialized = JSON.stringify(payloads(events))
    expect(serialized).not.toContain("thinking")
    expect(serialized).not.toContain("hmm")
    // The answer itself is untouched: exactly one text block opened for it.
    expect(events.filter((event) => event.event === "content_block_start")).toHaveLength(1)
  })
})

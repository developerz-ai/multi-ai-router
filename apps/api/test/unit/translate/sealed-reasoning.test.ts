import { describe, expect, test } from "bun:test"
import { createReasoningSealer } from "../../../src/services/crypto/reasoning-seal"
import { anthropicToOpenAiResponsesRequest as toResponses } from "../../../src/services/translate/anthropic-to-openai-responses/request"
import { openAiResponsesToAnthropicResponse as fromResponses } from "../../../src/services/translate/openai-responses-to-anthropic/response"
import { openAiResponsesToAnthropicStream as fromResponsesStream } from "../../../src/services/translate/openai-responses-to-anthropic/stream"
import { ROUTER_THINKING_SIGNATURE } from "../../../src/services/translate/shared/router-thinking"

/**
 * Prod fingerprint: Anthropic-wire tool loops against Codex/gpt reasoning models lost step N's
 * reasoning item on step N+1, so the upstream prefix cache broke every step (router gpt-6.1-sol cache
 * hit 0.07 / 0.64 / 0.89 by step). The encrypted reasoning now rides back to the client sealed for
 * the account that issued it and is replayed only to that account.
 */
const sealer = createReasoningSealer(Buffer.alloc(32, 7).toString("base64"))
const accountA = sealer.forAccount("account-a")
const accountB = sealer.forAccount("account-b")

const reasoningOutput = (summary: string) => ({
  type: "reasoning",
  id: "rs_1",
  summary: summary.length === 0 ? [] : [{ type: "summary_text", text: summary }],
  encrypted_content: "gAAAA-opaque-blob",
})

const upstreamBody = (summary: string) => ({
  id: "resp_1",
  model: "gpt-fixture",
  status: "completed",
  output: [
    reasoningOutput(summary),
    { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
  ],
  usage: { input_tokens: 10, output_tokens: 5 },
})

type Block = Record<string, unknown>
const contentOf = (body: unknown): Block[] => (body as { content: Block[] }).content

function nextTurn(assistant: readonly Block[], seal = accountA) {
  return toResponses(
    {
      model: "gpt-fixture",
      max_tokens: 100,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: assistant },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }] },
      ],
    },
    { reasoningSeal: seal },
  )
}

describe("request: encrypted reasoning is asked for only under a seal", () => {
  const request = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }
  test("sealed → include reasoning.encrypted_content", () => {
    expect(toResponses(request, { reasoningSeal: accountA }).include).toEqual([
      "reasoning.encrypted_content",
    ])
  })
  test("no seal → nothing requested, as before", () => {
    expect(toResponses(request).include).toBeUndefined()
  })
})

describe("non-stream response → next turn", () => {
  test("a summarized reasoning item becomes a sealed thinking block and replays in place", () => {
    const content = contentOf(fromResponses(upstreamBody("plan"), { reasoningSeal: accountA }).body)
    expect(content[0]).toEqual({
      type: "thinking",
      thinking: "plan",
      signature: accountA.seal("gAAAA-opaque-blob"),
    })
    const replay = nextTurn(content)
    expect(replay.input[1]).toEqual({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "plan" }],
      encrypted_content: "gAAAA-opaque-blob",
    })
    expect(replay.input[2]).toMatchObject({ type: "function_call", call_id: "call_1" })
  })

  test("a reasoning item with no summary becomes a sealed redacted_thinking block", () => {
    const content = contentOf(fromResponses(upstreamBody(""), { reasoningSeal: accountA }).body)
    expect(content[0]).toEqual({
      type: "redacted_thinking",
      data: accountA.seal("gAAAA-opaque-blob"),
    })
    expect(nextTurn(content).input[1]).toEqual({
      type: "reasoning",
      summary: [],
      encrypted_content: "gAAAA-opaque-blob",
    })
  })

  test("a block sealed for another account is dropped", () => {
    const content = contentOf(fromResponses(upstreamBody("plan"), { reasoningSeal: accountA }).body)
    const replay = nextTurn(content, accountB)
    expect(JSON.stringify(replay)).not.toContain("opaque-blob")
    expect(replay.input.some((item) => item.type === "reasoning")).toBe(false)
  })

  test("a tampered signature is dropped", () => {
    const signature = accountA.seal("gAAAA-opaque-blob")
    const forged = `${signature.slice(0, -2)}xx`
    const replay = nextTurn([
      { type: "thinking", thinking: "plan", signature: forged },
      { type: "redacted_thinking", data: forged },
      { type: "tool_use", id: "call_1", name: "read", input: {} },
    ])
    expect(replay.input.some((item) => item.type === "reasoning")).toBe(false)
  })

  test("router-tagged (mar1:) blocks stay dropped, and no seal replays nothing", () => {
    const tagged = nextTurn([
      { type: "thinking", thinking: "plan", signature: ROUTER_THINKING_SIGNATURE },
      { type: "tool_use", id: "call_1", name: "read", input: {} },
    ])
    expect(tagged.input.some((item) => item.type === "reasoning")).toBe(false)
    const unsealed = toResponses({
      model: "m",
      max_tokens: 10,
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "p", signature: accountA.seal("blob") }],
        },
      ],
    })
    expect(unsealed.input.some((item) => item.type === "reasoning")).toBe(false)
  })

  test("without a seal the response keeps the router tag and never carries the blob", () => {
    const content = contentOf(fromResponses(upstreamBody("plan")).body)
    expect(content[0]).toEqual({
      type: "thinking",
      thinking: "plan",
      signature: ROUTER_THINKING_SIGNATURE,
    })
    expect(JSON.stringify(content)).not.toContain("opaque-blob")
    expect(contentOf(fromResponses(upstreamBody("")).body)[0]?.type).toBe("tool_use")
  })

  test("the replayed prefix is byte-identical across two turns", () => {
    const content = contentOf(fromResponses(upstreamBody("plan"), { reasoningSeal: accountA }).body)
    const turn2 = nextTurn(content)
    const turn3 = toResponses(
      {
        model: "gpt-fixture",
        max_tokens: 100,
        messages: [
          { role: "user", content: "go" },
          { role: "assistant", content },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
          { role: "user", content: "next" },
        ],
      },
      { reasoningSeal: accountA },
    )
    const prefix = JSON.stringify(turn2.input)
    expect(JSON.stringify(turn3.input).startsWith(prefix.slice(0, -1))).toBe(true)
  })
})

describe("stream response", () => {
  const frame = (data: Record<string, unknown>) => ({
    event: String(data.type),
    data: JSON.stringify(data),
  })
  function run(summary: string, seal = accountA) {
    const stream = fromResponsesStream({ id: "msg_1", model: "m", reasoningSeal: seal })
    const frames = [
      frame({ type: "response.created", response: { id: "resp_1", model: "m" } }),
      frame({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1", summary: [] },
      }),
      ...(summary.length === 0
        ? []
        : [
            frame({
              type: "response.reasoning_summary_text.delta",
              item_id: "rs_1",
              output_index: 0,
              summary_index: 0,
              delta: summary,
            }),
          ]),
      frame({ type: "response.output_item.done", output_index: 0, item: reasoningOutput(summary) }),
    ]
    return frames.flatMap((f) => stream.push(f)).map((e) => JSON.parse(e.data) as Block)
  }

  test("the open thinking block closes with the sealed signature on output_item.done", () => {
    const events = run("plan")
    const signature = events.find((e) => (e.delta as Block | undefined)?.type === "signature_delta")
      ?.delta as Block
    expect(signature.signature).toBe(accountA.seal("gAAAA-opaque-blob"))
    expect(events.at(-1)?.type).toBe("content_block_stop")
  })

  test("no summary → a sealed redacted_thinking block", () => {
    const start = run("").find((e) => e.type === "content_block_start")
    expect(start?.content_block).toEqual({
      type: "redacted_thinking",
      data: accountA.seal("gAAAA-opaque-blob"),
    })
  })
})

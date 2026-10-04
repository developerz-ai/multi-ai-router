import { expect, test } from "bun:test"
import { openAiChatToAnthropicStream } from "../../../src/services/translate/openai-chat-to-anthropic/stream"
import { openAiChatToOpenAiResponsesStream } from "../../../src/services/translate/openai-chat-to-openai-responses/stream"
import { openAiResponsesToAnthropicStream } from "../../../src/services/translate/openai-responses-to-anthropic/stream"
import { openAiResponsesToOpenAiChatStream } from "../../../src/services/translate/openai-responses-to-openai-chat/stream"
import { createResponsesSnapshotRecovery } from "../../../src/services/translate/shared/responses-snapshot-recovery"
import type { SseEvent, StreamTranslator } from "../../../src/services/translate/sse/emit"

function push(t: StreamTranslator, event: object): readonly SseEvent[] {
  return t.push({ event: null, data: JSON.stringify(event) })
}
function text(events: readonly SseEvent[]) {
  return events
    .filter((e) => e.data !== "[DONE]")
    .map((e) => JSON.parse(e.data))
    .map(
      (e) => e.choices?.[0]?.delta?.content ?? (e.delta?.type === "text_delta" ? e.delta.text : ""),
    )
    .join("")
}
const factories = [
  () => openAiResponsesToAnthropicStream(),
  () => openAiResponsesToOpenAiChatStream({ created: 1 }),
]
for (const [index, factory] of factories.entries()) {
  for (const initially of ["", '{"x":1}'])
    test(`Responses ${index}: item.done preserves full arguments after added ${initially.length}`, () => {
      const t = factory()
      const call = {
        type: "function_call",
        id: "a",
        call_id: "call",
        name: "f",
        arguments: initially,
      }
      const events = [
        ...push(t, { type: "response.output_item.added", output_index: 0, item: call }),
        ...push(t, {
          type: "response.output_item.done",
          output_index: 0,
          item: { ...call, arguments: '{"x":1}' },
        }),
        ...push(t, { type: "response.completed", response: { status: "completed" } }),
      ]
        .filter((e) => e.data !== "[DONE]")
        .map((e) => JSON.parse(e.data))
      expect(
        events
          .map(
            (e) =>
              e.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ??
              e.delta?.partial_json ??
              "",
          )
          .join(""),
      ).toBe('{"x":1}')
      expect(
        events.filter(
          (e) =>
            e.choices?.[0]?.delta?.tool_calls?.[0]?.id === "call" || e.content_block?.id === "call",
        ),
      ).toHaveLength(1)
    })
  test(`Responses ${index}: final message item fills partial content without duplicate mirrors`, () => {
    const t = factory()
    const item = {
      type: "message",
      id: "m",
      content: [
        { type: "output_text", text: "hello" },
        { type: "refusal", refusal: "no" },
      ],
    }
    const out = [
      ...push(t, {
        type: "response.output_text.delta",
        item_id: "m",
        content_index: 0,
        delta: "he",
      }),
      ...push(t, { type: "response.output_item.done", output_index: 0, item }),
      ...push(t, { type: "response.output_item.done", output_index: 0, item }),
    ]
    expect(text(out)).toBe("hello\nno")
  })
}
test("snapshot hashing preserves split surrogate pairs and distinct part identities", () => {
  const recovery = createResponsesSnapshotRecovery()
  const common = { item_id: "a", content_index: 0, type: "response.output_text.delta" }
  recovery({ ...common, delta: "\ud83d" })
  recovery({ ...common, delta: "\ude42" })
  expect(recovery({ ...common, type: "response.output_text.done", text: "🙂!" }).event.delta).toBe(
    "!",
  )
  expect(
    recovery({ ...common, item_id: "b", type: "response.output_text.done", text: "other" }).event
      .delta,
  ).toBe("other")
  expect(recovery({ ...common, type: "response.output_text.done", text: "🙂!" }).event.delta).toBe(
    "",
  )
  expect(
    recovery({ ...common, type: "response.output_text.done", text: "🙂!changed" }).error,
  ).toBeDefined()
})
test("recovery identities are bounded and options reject nonfinite or fractional limits", () => {
  for (const maximumPendingBytes of [NaN, Infinity, 0, 1023, 1024.5, 33_554_433])
    expect(() => createResponsesSnapshotRecovery({ maximumPendingBytes })).toThrow(RangeError)
  const recovery = createResponsesSnapshotRecovery({ maximumPendingBytes: 1024 })
  let last: ReturnType<typeof recovery> | undefined
  for (let i = 0; i < 10; i++)
    last = recovery({ type: "response.output_text.delta", item_id: `part${i}`, delta: "x" })
  expect(last?.error).toBeDefined()
})
for (const target of ["anthropic", "responses"] as const) {
  test(`interleaved ${target}: text and parallel call order preserve all arguments`, () => {
    const t =
      target === "anthropic"
        ? openAiChatToAnthropicStream()
        : openAiChatToOpenAiResponsesStream({ created: 1 })
    const events = [
      ...push(t, {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: '{"x":' } }],
            },
          },
        ],
      }),
      ...push(t, {
        choices: [
          {
            delta: {
              content: "between",
              tool_calls: [
                { index: 0, function: { arguments: "1" } },
                { index: 1, id: "b", function: { name: "g", arguments: '{"y":' } },
              ],
            },
          },
        ],
      }),
      ...push(t, {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: "}" } },
                { index: 1, function: { arguments: "2}" } },
              ],
            },
          },
        ],
      }),
      ...t.push({ event: null, data: "[DONE]" }),
    ].map((e) => JSON.parse(e.data))
    if (target === "anthropic") {
      expect(
        events
          .filter((e) => e.delta?.type === "input_json_delta")
          .map((e) => e.delta.partial_json)
          .join(""),
      ).toBe('{"x":1}{"y":2}')
      expect(
        events.filter((e) => e.type === "content_block_start").map((e) => e.content_block.type),
      ).toEqual(["tool_use", "text", "tool_use"])
    } else {
      const final = events.find((e) => e.type === "response.completed")?.response.output
      expect(final.map((e: { type: string }) => e.type)).toEqual([
        "function_call",
        "message",
        "function_call",
      ])
      expect(
        final
          .filter((e: { type: string }) => e.type === "function_call")
          .map((e: { arguments: string }) => e.arguments),
      ).toEqual(['{"x":1}', '{"y":2}'])
    }
  })
  test(`interleaved ${target}: overflow fails honestly and never emits completion`, () => {
    const t =
      target === "anthropic"
        ? openAiChatToAnthropicStream({ maximumPendingBytes: 1024 })
        : openAiChatToOpenAiResponsesStream({ created: 1, maximumPendingBytes: 1024 })
    push(t, {
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: "{" } }] } },
      ],
    })
    const fail = push(t, { choices: [{ delta: { content: "x".repeat(1025) } }] })
    expect(fail.some((e) => JSON.parse(e.data).error || e.event === "error")).toBe(true)
    expect(t.translationFailure?.()).toMatchObject({ errorClass: "translation_pending_overflow" })
    expect(t.push({ event: null, data: "[DONE]" })).toEqual([])
  })
}

for (const [index, factory] of factories.entries())
  test(`Responses ${index}: final item recovers arguments whose earlier deltas had no metadata`, () => {
    const t = factory()
    expect(
      push(t, { type: "response.function_call_arguments.delta", item_id: "a", delta: '{"x":' }),
    ).toEqual([])
    const events = [
      ...push(t, {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", id: "a", call_id: "call", name: "f", arguments: '{"x":1}' },
      }),
      ...push(t, { type: "response.completed", response: { status: "completed" } }),
    ]
      .filter((e) => e.data !== "[DONE]")
      .map((e) => JSON.parse(e.data))
    expect(
      events
        .map(
          (e) =>
            e.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ??
            e.delta?.partial_json ??
            "",
        )
        .join(""),
    ).toBe('{"x":1}')
  })

test("a confirmed tool item releases queued text while a later call can keep streaming", () => {
  const t = openAiResponsesToAnthropicStream()
  const a = { type: "function_call", id: "a", call_id: "ca", name: "f" }
  const b = { type: "function_call", id: "b", call_id: "cb", name: "g" }
  push(t, { type: "response.output_item.added", output_index: 0, item: a })
  push(t, { type: "response.function_call_arguments.delta", item_id: "a", delta: "{}" })
  expect(
    push(t, {
      type: "response.output_text.delta",
      item_id: "m",
      content_index: 0,
      delta: "between",
    }),
  ).toEqual([])
  push(t, { type: "response.output_item.added", output_index: 2, item: b })
  push(t, { type: "response.function_call_arguments.delta", item_id: "b", delta: '{"x":' })
  const ready = push(t, {
    type: "response.output_item.done",
    output_index: 0,
    item: { ...a, arguments: "{}" },
  }).map((e) => JSON.parse(e.data))
  expect(
    ready
      .filter((e) => e.delta?.type === "text_delta")
      .map((e) => e.delta.text)
      .join(""),
  ).toBe("between")
  expect(
    ready.filter((e) => e.content_block?.type === "tool_use").map((e) => e.content_block.id),
  ).toEqual(["cb"])
  const late = push(t, {
    type: "response.function_call_arguments.delta",
    item_id: "b",
    delta: "1}",
  }).map((e) => JSON.parse(e.data))
  expect(
    late
      .filter((e) => e.delta?.type === "input_json_delta")
      .map((e) => e.delta.partial_json)
      .join(""),
  ).toBe("1}")
})

test("Chat joins tool and text ID/index aliases without losing arguments or adding separators", () => {
  const t = openAiResponsesToOpenAiChatStream({ created: 1 })
  const events = [
    ...push(t, {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "a", call_id: "call", name: "f", arguments: "" },
    }),
    ...push(t, { type: "response.function_call_arguments.delta", output_index: 0, delta: "{}" }),
    ...push(t, {
      type: "response.function_call_arguments.done",
      item_id: "a",
      output_index: 0,
      arguments: "{}",
    }),
    ...push(t, {
      type: "response.output_text.delta",
      item_id: "m",
      output_index: 1,
      content_index: 0,
      delta: "Hel",
    }),
    ...push(t, {
      type: "response.output_text.done",
      output_index: 1,
      content_index: 0,
      text: "Hello",
    }),
  ]
  const calls = events
    .map((e) => JSON.parse(e.data))
    .flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? [])
  expect(calls.map((c) => c.function.arguments ?? "").join("")).toBe("{}")
  expect(text(events)).toBe("Hello")
  expect(t.translationFailure?.()).toBeNull()
})

test("Chat rejects conflicting tool aliases and bounds empty tool identities", () => {
  const t = openAiResponsesToOpenAiChatStream({ created: 1 })
  for (const id of ["a", "b"])
    push(t, {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id, call_id: id, name: "f", arguments: "" },
    })
  expect(t.translationFailure?.()).toMatchObject({ errorClass: "translation_protocol_error" })
  const bounded = openAiResponsesToOpenAiChatStream({ created: 1, maximumPendingBytes: 1024 })
  for (let i = 0; i < 100; i++)
    push(bounded, {
      type: "response.output_item.added",
      output_index: i,
      item: { type: "function_call", id: `a${i}`, call_id: `c${i}`, name: "f", arguments: "" },
    })
  expect(bounded.translationFailure?.()).toMatchObject({
    errorClass: "translation_pending_overflow",
  })
})

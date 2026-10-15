/**
 * A forced tool a third-party vendor answered in text (`shared/forced-tool-coercion.ts`).
 * Prod fingerprint, 2026-10-15: MiniMax-M3 answers developerz.ai's forced `json` tool with
 * `end_turn` and a text block `{"ok": true}`, whatever `thinking` says.
 */
import { describe, expect, test } from "bun:test"
import {
  coerceMessage,
  coerceStream,
  forcedToolFromRequest,
  jsonObjectFromText,
} from "../../../src/services/translate/shared/forced-tool-coercion"
import { anthropicFrame } from "./fixtures"

const id = () => "toolu_test"
const tool = (name: string) => ({ name, input_schema: { type: "object" } })

describe("forcedToolFromRequest", () => {
  test("a named tool", () => {
    expect(forcedToolFromRequest({ tool_choice: { type: "tool", name: "json" } })).toBe("json")
  })
  test("any with exactly one tool", () => {
    expect(forcedToolFromRequest({ tool_choice: { type: "any" }, tools: [tool("json")] })).toBe(
      "json",
    )
  })
  test("any with several tools, or none, names nothing", () => {
    expect(
      forcedToolFromRequest({ tool_choice: { type: "any" }, tools: [tool("a"), tool("b")] }),
    ).toBeNull()
    expect(forcedToolFromRequest({ tool_choice: { type: "any" } })).toBeNull()
  })
  test("auto, none and absent force nothing", () => {
    expect(forcedToolFromRequest({ tool_choice: { type: "auto" }, tools: [tool("a")] })).toBeNull()
    expect(forcedToolFromRequest({ tool_choice: { type: "none" }, tools: [tool("a")] })).toBeNull()
    expect(forcedToolFromRequest({ tools: [tool("a")] })).toBeNull()
    expect(forcedToolFromRequest(null)).toBeNull()
  })
})

describe("jsonObjectFromText", () => {
  test("bare, padded and fenced objects", () => {
    expect(jsonObjectFromText('{"ok": true}')).toEqual({ ok: true })
    expect(jsonObjectFromText('  \n{"ok": true}\n ')).toEqual({ ok: true })
    expect(jsonObjectFromText('```json\n{"ok": true}\n```')).toEqual({ ok: true })
    expect(jsonObjectFromText('```\n{"ok": true}\n```')).toEqual({ ok: true })
  })
  test("prose, arrays, scalars, truncated and prose-around-fence are not objects", () => {
    for (const text of [
      "Sure! here",
      '[{"ok": true}]',
      "42",
      "null",
      '{"ok": tr',
      'Here:\n```json\n{"ok": true}\n```',
      '{"a":1} and {"b":2}',
      "",
    ]) {
      expect(jsonObjectFromText(text)).toBeNull()
    }
  })
})

const message = (content: unknown[], stop = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "MiniMax-M3",
  content,
  stop_reason: stop,
  usage: { input_tokens: 1, output_tokens: 2 },
})

describe("coerceMessage", () => {
  test("text holding the object becomes the tool_use, other text dropped", () => {
    const out = coerceMessage(message([{ type: "text", text: '{"ok": true}' }]), "json", id)
    expect(out).toMatchObject({
      content: [{ type: "tool_use", id: "toolu_test", name: "json", input: { ok: true } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 2 },
    })
  })

  test("a fenced object split across text blocks", () => {
    const out = coerceMessage(
      message([
        { type: "text", text: '```json\n{"ok":' },
        { type: "text", text: " true}\n```" },
      ]),
      "json",
      id,
    )
    expect(((out?.content ?? []) as { input: unknown }[])[0]?.input).toEqual({ ok: true })
  })

  test("a schema-violating object is still coerced: the client validates", () => {
    expect(
      coerceMessage(message([{ type: "text", text: '{"nope": 1}' }]), "json", id),
    ).not.toBeNull()
  })

  test("never coerced: a tool_use already there, prose, array, truncated, non-message", () => {
    const left = (value: unknown) => expect(coerceMessage(value, "json", id)).toBeNull()
    left(message([{ type: "tool_use", id: "t", name: "json", input: {} }], "tool_use"))
    left(message([{ type: "text", text: "Sure, here you go" }]))
    left(message([{ type: "text", text: '[{"ok": true}]' }]))
    left(message([{ type: "text", text: '{"ok": tr' }], "max_tokens"))
    left(message([]))
    left({ error: "x" })
  })
})

describe("coerceStream", () => {
  const frames = (text: string, stop = "end_turn") =>
    [
      anthropicFrame("message_start", {
        message: { id: "msg_1", model: "m", usage: { input_tokens: 3 } },
      }),
      anthropicFrame("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      anthropicFrame("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: text.slice(0, 5) },
      }),
      anthropicFrame("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: text.slice(5) },
      }),
      anthropicFrame("content_block_stop", { index: 0 }),
      anthropicFrame("message_delta", {
        delta: { stop_reason: stop },
        usage: { output_tokens: 7 },
      }),
      anthropicFrame("message_stop"),
    ]
      .map((frame) => `event: ${frame.event}\ndata: ${frame.data}\n\n`)
      .join("")
  const run = (sse: string) => {
    const out = coerceStream(new TextEncoder().encode(sse), "json", id)
    return out === null ? null : new TextDecoder().decode(out)
  }

  test("a valid sequence carrying the tool call, usage and ids intact", () => {
    const out = run(frames('{"ok": true}'))
    expect(out).not.toBeNull()
    const events = (out ?? "")
      .split("\n\n")
      .filter(Boolean)
      .map((block) => ({
        event: /event: (.*)/.exec(block)?.[1],
        data: JSON.parse(/data: (.*)/.exec(block)?.[1] ?? "{}") as {
          type: string
          message: { usage: unknown }
          content_block: unknown
          delta: { partial_json: string; stop_reason: string }
          usage: unknown
        },
      }))
    expect(events.map((e) => e.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(events.map((e) => e.data.type)).toEqual(events.map((e) => e.event))
    expect(events[0]?.data.message.usage).toEqual({ input_tokens: 3 })
    expect(events[1]?.data.content_block).toMatchObject({
      type: "tool_use",
      id: "toolu_test",
      name: "json",
    })
    expect(JSON.parse(events[2]?.data.delta.partial_json)).toEqual({ ok: true })
    expect(events[4]?.data.delta.stop_reason).toBe("tool_use")
    expect(events[4]?.data.usage).toEqual({ output_tokens: 7 })
  })

  test("prose, an array, a truncated stream and an error pass through (null)", () => {
    expect(run(frames("Sure, here you go"))).toBeNull()
    expect(run(frames('[{"ok": true}]'))).toBeNull()
    expect(run(frames('{"ok": true}', "max_tokens"))).toBeNull()
    // A stream that never reached `message_stop` was cut short; nothing is invented for it.
    expect(run(frames('{"ok": true}').split("event: message_stop")[0] ?? "")).toBeNull()
    expect(
      run(
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error" } })}\n\n`,
      ),
    ).toBeNull()
  })
})

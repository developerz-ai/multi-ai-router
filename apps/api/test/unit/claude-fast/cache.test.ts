import { describe, expect, test } from "bun:test"
import { placeCacheBreakpoints } from "../../../src/providers/claude-fast/cache"
import { prepareFastRequest, readFastRequest } from "../../../src/providers/claude-fast/request"

/**
 * Breakpoint placement. A client that marks only its system prompt never cached its history: prod
 * 2026-11-23, one conversation read 23,181 cached tokens flat while its uncached input grew from 2,802
 * to 36,177 in forty seconds.
 */

type Block = Record<string, unknown>
interface Message {
  role: string
  content: string | Block[]
}

const identity = {
  accessToken: "private-token",
  expiresAt: 9e15,
  deviceId: "a".repeat(64),
  accountUuid: "11111111-1111-4111-8111-111111111111",
}
function prepare(body: object) {
  const prepared = prepareFastRequest({
    request: readFastRequest(Buffer.from(JSON.stringify({ max_tokens: 64, ...body }))),
    model: "claude-sonnet-5-5",
    identity,
    accountId: "account",
    apiKeyId: "key",
    sessionKey: "session",
  })
  if (!prepared) throw new Error("not prepared")
  return JSON.parse(prepared.text) as { system: Block[]; messages: Message[]; tools: Block[] }
}
const marked: Block = { type: "ephemeral" }
const system = [{ type: "text", text: "rules", cache_control: marked }]
const tool = (id: string): Message[] => [
  { role: "assistant", content: [{ type: "tool_use", id, name: "read", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `result ${id}` }] },
]
const first: Message = { role: "user", content: "start" }
const tailOf = (body: { messages: Message[] }) => {
  const content = body.messages.at(-1)?.content
  return Array.isArray(content) ? content.at(-1) : content
}
const markers = (value: unknown): number =>
  Array.isArray(value)
    ? value.reduce<number>((sum, entry) => sum + markers(entry), 0)
    : typeof value === "object" && value !== null
      ? Object.entries(value).reduce(
          (sum, [key, nested]) => sum + (key === "cache_control" ? 1 : markers(nested)),
          0,
        )
      : 0

describe("a client that marks only its prefix", () => {
  test("gets one five-minute breakpoint on the tail of an answered conversation", () => {
    const body = prepare({ system, messages: [first, ...tool("a")] })
    expect(tailOf(body)).toMatchObject({ type: "tool_result", cache_control: marked })
    expect(markers(body)).toBe(2)
    // The client's own marker is where and what it was.
    expect(body.system.at(-1)).toEqual(system[0])
  })

  test("pays no write for a one-shot", () => {
    expect(markers(prepare({ system, messages: [first] }))).toBe(1)
  })

  test("is left alone once it marks any message, however deep", () => {
    for (const content of [
      [{ type: "text", text: "start", cache_control: marked }],
      [
        {
          type: "tool_result",
          tool_use_id: "z",
          content: [{ type: "text", text: "x", cache_control: marked }],
        },
      ],
    ]) {
      const body = prepare({ system, messages: [{ role: "user", content }, ...tool("a")] })
      expect(markers(body)).toBe(2)
      expect(tailOf(body)).not.toHaveProperty("cache_control")
    }
  })

  test("never gains a fifth breakpoint", () => {
    const four = [0, 1, 2, 3].map((n) => ({ ...system[0], text: `rules ${n}` }))
    expect(markers(prepare({ system: four, messages: [first, ...tool("a")] }))).toBe(4)
    const three = four.slice(1)
    expect(markers(prepare({ system: three, messages: [first, ...tool("a")] }))).toBe(4)
    const tools = [{ name: "read", input_schema: { type: "object" }, cache_control: marked }]
    expect(markers(prepare({ system: three, tools, messages: [first, ...tool("a")] }))).toBe(4)
  })

  test("a native Claude Code request and a top-level cache_control are untouched", () => {
    const billing = {
      type: "text",
      text: "x-anthropic-billing-header: cc_version=2.1.319.abc; cc_entrypoint=cli; cch=12345;",
    }
    const native = prepare({ system: [billing, ...system], messages: [first, ...tool("a")] })
    expect(markers(native.messages)).toBe(0)
    const automatic = prepare({ cache_control: marked, system, messages: [first, ...tool("a")] })
    expect(markers(automatic.messages)).toBe(0)
  })

  test("a thinking or empty tail takes no marker", () => {
    const thinking = { type: "thinking", thinking: "…", signature: "s" }
    for (const content of [[thinking], [{ type: "text", text: "" }], ""]) {
      const body = prepare({
        system,
        messages: [first, ...tool("a"), { role: "assistant", content }],
      })
      expect(markers(body.messages)).toBe(0)
    }
  })

  test("the prefix each turn caches is the prefix the next turn sends", () => {
    const strip = (messages: Message[]) =>
      messages.map((message) => ({
        role: message.role,
        content: (typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content
        ).map(({ cache_control: _dropped, ...block }) => block),
      }))
    const history: Message[] = [first, ...tool("a")]
    let previous = prepare({ system, messages: history })
    for (const id of ["b", "c", "d"]) {
      history.push(...tool(id))
      const next = prepare({ system, messages: history })
      expect(strip(next.messages).slice(0, previous.messages.length)).toEqual(
        strip(previous.messages),
      )
      expect(next.system.slice(1)).toEqual(previous.system.slice(1))
      expect(tailOf(next)).toMatchObject({ tool_use_id: id, cache_control: marked })
      previous = next
    }
  })
})

test("with no marker anywhere the native-style hour-long ones are unchanged", () => {
  const body = prepare({ system: "rules", messages: [first] })
  const hour = { type: "ephemeral", ttl: "1h" }
  expect(body.system[1]?.cache_control).toEqual(hour)
  expect(body.system.at(-1)?.cache_control).toEqual(hour)
  expect(tailOf(body)).toEqual({ type: "text", text: "start", cache_control: hour })
})

test("a native request with a marked prefix never has its history walked", () => {
  const history = {
    role: "user",
    get content(): string {
      throw new Error("walked")
    },
  }
  expect(() =>
    placeCacheBreakpoints({
      system: [{ type: "text", text: "rules", cache_control: marked }],
      messages: [history],
      tools: undefined,
      unmarked: false,
      native: true,
    }),
  ).not.toThrow()
})

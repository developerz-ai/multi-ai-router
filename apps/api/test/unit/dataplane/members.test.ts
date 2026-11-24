import { describe, expect, test } from "bun:test"
import {
  disableThinkingForForcedTool,
  keepThinkingForRequiredModel,
} from "../../../src/services/dataplane/body/forced-tool-thinking"
import {
  memberValue,
  topLevelMembers,
  withMember,
} from "../../../src/services/dataplane/body/members"
import { withProviderPreferences } from "../../../src/services/dataplane/body/provider-preferences"
import { forcedToolOfBody } from "../../../src/services/dataplane/forced-tool-coercion"

const enc = (text: string) => new TextEncoder().encode(text)
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const span = (text: string, key: string) =>
  memberValue(enc(text), topLevelMembers(enc(text), [key])?.values.get(key))

describe("top-level members by span", () => {
  test("only the top level: a nested or quoted look-alike is not the member", () => {
    const text = '{"a":{"k":1},"s":"\\"k\\":2","l":[{"k":3}],"k":{"v":"}]\\\\"}}'
    expect(span(text, "k")).toEqual({ v: "}]\\" })
    expect(span('{"a":{"k":1}}', "k")).toBeUndefined()
  })

  test("a repeated key reads as JSON.parse reads it, and an escaped key is the key it spells", () => {
    expect(span('{"k":1,"k":2}', "k")).toBe(2)
    expect(span('{"\\u006b":7}', "k")).toBe(7)
  })

  test("every value shape, with whitespace anywhere", () => {
    for (const value of ['"s"', "12.50", "true", "null", "[1,[2]]", '{"a":{}}'])
      for (const pad of ["", " ", "\n\t"]) {
        const text = `{${pad}"x"${pad}:${pad}${value}${pad},${pad}"k"${pad}:${pad}${value}${pad}}`
        expect(span(text, "k")).toEqual(JSON.parse(value))
      }
  })

  test("agrees with JSON.parse on generated bodies", () => {
    const strings = ["", 'a"b', "\\", "é→😀", "{", "x".repeat(300), "\n"]
    const value = (depth: number): unknown => {
      const pick = Math.floor(Math.random() * (depth > 3 ? 4 : 6))
      if (pick === 0) return strings[Math.floor(Math.random() * strings.length)]
      if (pick === 1) return Math.random() * 1e6
      if (pick === 2) return null
      if (pick === 3) return Math.random() < 0.5
      if (pick === 4) return Array.from({ length: 3 }, () => value(depth + 1))
      return Object.fromEntries(["k", "z", strings[1] ?? "q"].map((key) => [key, value(depth + 1)]))
    }
    for (let i = 0; i < 2_000; i++) {
      const body = { a: value(0), k: value(0), [strings[i % strings.length] ?? "q"]: value(0) }
      const text = JSON.stringify(body, null, i % 3 === 0 ? 1 : undefined)
      expect(span(text, "k")).toEqual(JSON.parse(text).k)
    }
  })

  test("what is not an object is left alone", () => {
    for (const text of ["", "[]", '"k"', "{", '{"k"', '{"k":1'])
      expect(topLevelMembers(enc(text), ["k"])).toBeNull()
    const empty = enc(" { } ")
    const top = topLevelMembers(empty, ["k"])
    if (top === null) throw new Error("an empty object is an object")
    expect(dec(withMember(empty, top, "k", 1))).toBe(' {"k":1 } ')
  })
})

/**
 * Through 2.76.1 each of these edits parsed the whole body and wrote it back: an id past 2^53 reached
 * the vendor as a different number, on a path documented as byte passthrough.
 */
describe("a passthrough edit leaves every other byte as the client sent it", () => {
  const REST = '"seed":9007199254740993,"top_p":1.0,"messages":[{"id":1E400,"x":"\\u00e9"}]'

  test("a forced tool states thinking off", () => {
    const out = disableThinkingForForcedTool(enc(`{${REST},"tool_choice":{"type":"any"}}`))
    expect(dec(out)).toBe(`{"thinking":{"type":"disabled"},${REST},"tool_choice":{"type":"any"}}`)
  })

  test("a stated thinking is replaced where it stands", () => {
    const body = `{"thinking":{"type":"enabled","budget_tokens":9},${REST},"tool_choice":{"type":"tool","name":"t"}}`
    expect(dec(disableThinkingForForcedTool(enc(body)))).toBe(
      body.replace('{"type":"enabled","budget_tokens":9}', '{"type":"disabled"}'),
    )
  })

  test("thinking kept on for a model that requires it", () => {
    const out = dec(keepThinkingForRequiredModel(enc(`{"thinking":{"type":"disabled"},${REST}}`)))
    expect(out).toBe(`{"output_config":{"effort":"low"},"thinking":{"type":"adaptive"},${REST}}`)
  })

  test("a client's own provider object is merged, the rest untouched", () => {
    const out = withProviderPreferences(enc(`{${REST},"provider":{"sort":"latency"}}`), {
      sort: "price",
      allow_fallbacks: true,
    } as never)
    expect(dec(out)).toBe(`{${REST},"provider":{"sort":"latency","allow_fallbacks":true}}`)
  })
})

test("the forced tool is read without parsing the transcript", () => {
  const tools = '"tools":[{"name":"json"}]'
  expect(forcedToolOfBody(enc(`{${tools},"tool_choice":{"type":"any"}}`))).toBe("json")
  expect(forcedToolOfBody(enc(`{"tool_choice":{"type":"tool","name":"t"}}`))).toBe("t")
  expect(forcedToolOfBody(enc(`{${tools},"tool_choice":{"type":"auto"}}`))).toBeUndefined()
  expect(forcedToolOfBody(enc(`{"x":"\\"tool_choice\\""}`))).toBeUndefined()
})

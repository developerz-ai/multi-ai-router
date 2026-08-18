import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { PERMITTED_TOOLS } from "../../../src/providers/claude-sdk/allowlist"
import {
  PASSTHROUGH_SERVER_NAME,
  qualifyToolName,
  unprefixToolName,
} from "../../../src/providers/claude-sdk/tools/names"
import { passthroughToolDefinition } from "../../../src/providers/claude-sdk/tools/passthrough"
import {
  createPassthrough,
  DEFER_LOADING_THRESHOLD,
  type DeclaredTool,
  readDeclaredTools,
  TOOL_SEARCH,
} from "../../../src/providers/claude-sdk/tools/register"
import { repairToolInput } from "../../../src/providers/claude-sdk/tools/repair"
import { readToolSchema } from "../../../src/providers/claude-sdk/tools/schema"

/**
 * The declaration half of tool passthrough: what the SDK is told a client's tools are, in what
 * order, and with what shape (docs/idea/11-anthropic-agent-sdk.md §7).
 *
 * The stream half — capture, deny-hold, early stop, name and argument rewriting — is
 * `tool-gate.test.ts`. Everything here is a pure function over plain values, so nothing is mocked
 * and no clock is involved (CLAUDE.md testing rules).
 */

function declared(name: string, extra: Record<string, unknown> = {}): DeclaredTool {
  return { name, description: `the ${name} tool`, input_schema: { type: "object" }, ...extra }
}

function jsonSchemaOf(input: unknown): Record<string, unknown> {
  const parsed: unknown = z.toJSONSchema(z.object(readToolSchema(input).shape))
  return parsed as Record<string, unknown>
}

describe("the mcp__<server>__ prefix", () => {
  test("qualifying names the one in-process server, and un-prefixing takes it back off", () => {
    expect(qualifyToolName("get_weather")).toBe(`mcp__${PASSTHROUGH_SERVER_NAME}__get_weather`)
    expect(unprefixToolName(qualifyToolName("get_weather"))).toBe("get_weather")
  })

  test("a name that never carried the prefix is returned untouched — the SDK sends both forms", () => {
    expect(unprefixToolName("get_weather")).toBe("get_weather")
    expect(unprefixToolName("Bash")).toBe("Bash")
  })

  test("exactly one prefix comes off, so a tool genuinely named mcp__client__x round-trips", () => {
    const awkward = `mcp__${PASSTHROUGH_SERVER_NAME}__x`
    expect(unprefixToolName(qualifyToolName(awkward))).toBe(awkward)
  })

  test("another server's namespace is not ours to strip", () => {
    expect(unprefixToolName("mcp__github__create_issue")).toBe("mcp__github__create_issue")
  })
})

describe("a client's JSON Schema, round-tripped through Zod for MCP registration", () => {
  test("required stays required, optional stays optional, and descriptions survive", () => {
    const schema = jsonSchemaOf({
      type: "object",
      properties: {
        filePath: { type: "string", description: "where to read" },
        limit: { type: "integer" },
      },
      required: ["filePath"],
    })
    expect(schema.required).toEqual(["filePath"])
    expect(schema.properties).toMatchObject({
      filePath: { type: "string", description: "where to read" },
      limit: { type: "integer" },
    })
  })

  test("enums come back as enums, not as a union of consts — the catalogue is billed per token", () => {
    const schema = jsonSchemaOf({ type: "object", properties: { mode: { enum: ["r", "w"] } } })
    expect(schema.properties).toMatchObject({ mode: { type: "string", enum: ["r", "w"] } })
  })

  test("nested objects and arrays keep their structure", () => {
    const schema = jsonSchemaOf({
      type: "object",
      properties: {
        opts: { type: "object", properties: { deep: { type: "boolean" } }, required: ["deep"] },
        tags: { type: "array", items: { type: "string" } },
      },
    })
    expect(schema.properties).toMatchObject({
      opts: { type: "object", properties: { deep: { type: "boolean" } }, required: ["deep"] },
      tags: { type: "array", items: { type: "string" } },
    })
  })

  test("a keyword this reader cannot represent goes unconstrained, never guessed", () => {
    const { shape } = readToolSchema({
      type: "object",
      properties: { weird: { $ref: "#/definitions/nope" } },
      required: ["weird"],
    })
    // Unconstrained, so anything the model puts there parses — and nothing the client did not say
    // has been invented on its behalf.
    expect(z.object(shape).safeParse({ weird: { any: "shape" } }).success).toBe(true)
    expect(z.object(shape).safeParse({}).success).toBe(false)
  })

  test("a missing input_schema is a tool taking no arguments, not an error", () => {
    const schema = readToolSchema(undefined)
    expect(schema.properties).toEqual([])
    expect(schema.required).toEqual([])
  })

  test("a property named __proto__ defines a property instead of running the inherited setter", () => {
    // Parsed rather than written as a literal: `{ __proto__: … }` in source *is* the setter, which
    // is the very thing the reader must not reach for when the name comes from a caller.
    const { shape } = readToolSchema(
      JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"required":[]}'),
    )
    expect(Object.hasOwn(shape, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(shape)).toBe(Object.prototype)
  })

  test("a pathological nesting depth degrades instead of overflowing the stack", () => {
    let node: Record<string, unknown> = { type: "string" }
    for (let i = 0; i < 500; i += 1) node = { type: "array", items: node }
    const { shape } = readToolSchema({ type: "object", properties: { deep: node } })
    expect(Object.keys(shape)).toEqual(["deep"])
  })
})

describe("param-name repair renames case, and only case, and only when required", () => {
  const schema = readToolSchema({
    type: "object",
    properties: { filePath: { type: "string" }, limit: { type: "integer" } },
    required: ["filePath"],
  })

  test("a required camelCase parameter the model spelled snake_case is renamed", () => {
    const repaired = repairToolInput({ file_path: "/tmp/x", limit: 3 }, schema)
    expect(repaired.input).toEqual({ filePath: "/tmp/x", limit: 3 })
    expect(repaired.renamed).toEqual([["file_path", "filePath"]])
  })

  test("an optional parameter is never renamed onto — the model is allowed to omit it", () => {
    const repaired = repairToolInput({ filePath: "/tmp/x", Limit: 3 }, schema)
    expect(repaired.input).toEqual({ filePath: "/tmp/x", Limit: 3 })
    expect(repaired.renamed).toEqual([])
  })

  test("a required parameter already supplied is left alone even beside a folding neighbour", () => {
    const repaired = repairToolInput({ filePath: "/a", file_path: "/b" }, schema)
    expect(repaired.input).toEqual({ filePath: "/a", file_path: "/b" })
  })

  test("a different name is a guess, and repair does not guess", () => {
    const repaired = repairToolInput({ path: "/tmp/x" }, schema)
    expect(repaired.input).toEqual({ path: "/tmp/x" })
    expect(repaired.renamed).toEqual([])
  })

  test("a schema declaring both spellings is left exactly as it arrived", () => {
    const both = readToolSchema({
      type: "object",
      properties: { filePath: { type: "string" }, file_path: { type: "string" } },
      required: ["filePath"],
    })
    const repaired = repairToolInput({ file_path: "/tmp/x" }, both)
    expect(repaired.input).toEqual({ file_path: "/tmp/x" })
  })

  test("a required parameter named after an inherited member is not read as already supplied", () => {
    const inherited = readToolSchema({
      type: "object",
      properties: { toString: { type: "string" } },
      required: ["toString"],
    })
    expect(repairToolInput({ to_string: "x" }, inherited).input).toEqual({ toString: "x" })
  })

  test("a __proto__ argument survives as data and pollutes nothing while a sibling is repaired", () => {
    const repaired = repairToolInput(
      JSON.parse('{"__proto__":{"polluted":true},"file_path":"/tmp/x"}'),
      schema,
    )
    expect(repaired.renamed).toEqual([["file_path", "filePath"]])
    expect(Object.hasOwn(repaired.input, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(repaired.input)).toBe(Object.prototype)
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect(Object.hasOwn({}, "polluted")).toBe(false)
  })
})

describe("registration is deterministic, because order is the system prompt", () => {
  test("tools register alphabetically however the client ordered them", () => {
    const one = createPassthrough({ tools: [declared("zebra"), declared("alpha")] })
    const two = createPassthrough({ tools: [declared("alpha"), declared("zebra")] })
    expect(one?.registered).toEqual(["alpha", "zebra"])
    expect(two?.registered).toEqual(one?.registered)
  })

  test("sorting is by code point, never by locale — a replica must not change the prompt", () => {
    const passthrough = createPassthrough({
      tools: [declared("Zulu"), declared("alpha"), declared("Alpha")],
    })
    expect(passthrough?.registered).toEqual(["Alpha", "Zulu", "alpha"])
  })

  test("a duplicated name keeps the first declaration, wherever the duplicate landed", () => {
    const passthrough = createPassthrough({
      tools: [declared("a", { description: "first" }), declared("a", { description: "second" })],
    })
    expect(passthrough?.registered).toEqual(["a"])
  })

  test("a client that sent no tools gets no passthrough machinery at all", () => {
    expect(createPassthrough({ tools: [] })).toBeNull()
  })
})

describe("tool_choice decides what gets registered, and whether a call is required", () => {
  test('absent and "auto" both register everything and never require a call', () => {
    const tools = [declared("a"), declared("b")]
    expect(createPassthrough({ tools })?.required).toBe(false)
    expect(createPassthrough({ tools, toolChoice: { type: "auto" } })?.required).toBe(false)
    expect(createPassthrough({ tools, toolChoice: { type: "auto" } })?.registered).toEqual([
      "a",
      "b",
    ])
  })

  test('"none" returns no passthrough at all, the same as a client with no tools', () => {
    const tools = [declared("a"), declared("b")]
    expect(createPassthrough({ tools, toolChoice: { type: "none" } })).toBeNull()
  })

  test('"any" registers everything and requires a call', () => {
    const tools = [declared("a"), declared("b")]
    const passthrough = createPassthrough({ tools, toolChoice: { type: "any" } })
    expect(passthrough?.registered).toEqual(["a", "b"])
    expect(passthrough?.required).toBe(true)
  })

  test('"tool" narrows registration to the named tool only, and requires a call', () => {
    const tools = [declared("a"), declared("b")]
    const passthrough = createPassthrough({
      tools,
      toolChoice: { type: "tool", name: "b" },
    })
    expect(passthrough?.registered).toEqual(["b"])
    expect(passthrough?.required).toBe(true)
  })

  test("forcing a tool the client never declared throws rather than silently falling back", () => {
    const tools = [declared("a")]
    expect(() => createPassthrough({ tools, toolChoice: { type: "tool", name: "ghost" } })).toThrow(
      /ghost/,
    )
  })

  test('"any" with zero declared tools throws rather than silently downgrading to a plain chat', () => {
    // Anthropic's own API rejects a forced choice with no tools declared; returning null here would
    // answer it as an ordinary chat turn — the exact silent downgrade this issue exists to prevent.
    expect(() => createPassthrough({ tools: [], toolChoice: { type: "any" } })).toThrow(
      /declared no tools/,
    )
    // The same reading with no forced choice stays a plain chat turn, as it must.
    expect(createPassthrough({ tools: [] })).toBeNull()
    expect(createPassthrough({ tools: [], toolChoice: { type: "auto" } })).toBeNull()
  })
})

describe("deferred loading is described but not granted, because ToolSearch is not permitted", () => {
  const many = Array.from({ length: DEFER_LOADING_THRESHOLD + 5 }, (_, i) =>
    declared(`tool_${String(i).padStart(2, "0")}`),
  )

  test("the deferral threshold is only honoured when the reviewed allowlist grants ToolSearch", () => {
    // The security gate in `claude-sdk-security.test.ts` pins this list empty. Deferring the tail
    // behind a search the model cannot run would hide it, so every tool stays loaded instead.
    expect(PERMITTED_TOOLS).not.toContain(TOOL_SEARCH)
    const passthrough = createPassthrough({ tools: many })
    expect(passthrough?.registered).toHaveLength(many.length)
  })

  test("registering the client's tools never widens what may execute on this host", () => {
    const passthrough = createPassthrough({ tools: many })
    expect(Object.keys(passthrough?.mcpServers ?? {})).toEqual([PASSTHROUGH_SERVER_NAME])
    expect(PERMITTED_TOOLS).toEqual([])
  })
})

describe("a registered tool declares itself and executes nothing", () => {
  test("alwaysLoad is carried as the SDK's own per-tool metadata", () => {
    const loaded = passthroughToolDefinition({
      name: "a",
      description: "d",
      schema: readToolSchema({ type: "object" }),
      alwaysLoad: true,
    })
    expect(loaded._meta).toEqual({ "anthropic/alwaysLoad": true })
  })

  test("the handler refuses instead of returning a plausible empty result", async () => {
    const definition = passthroughToolDefinition({
      name: "get_weather",
      description: "d",
      schema: readToolSchema({ type: "object" }),
      alwaysLoad: true,
    })
    const result = await definition.handler({}, undefined)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain("get_weather")
    expect(JSON.stringify(result.content)).toContain("client")
  })
})

describe("reading the client's tools off an Anthropic Messages body", () => {
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value))

  test("declared tools come back in the order the client sent them", () => {
    const body = encode({ model: "m", messages: [], tools: [declared("b"), declared("a")] })
    expect(readDeclaredTools(body).map((t) => t.name)).toEqual(["b", "a"])
  })

  test("absent, empty, and unreadable bodies all mean the same thing: no client toolkit", () => {
    expect(readDeclaredTools(null)).toEqual([])
    expect(readDeclaredTools(new Uint8Array())).toEqual([])
    expect(readDeclaredTools(new TextEncoder().encode("{not json"))).toEqual([])
    expect(readDeclaredTools(encode({ model: "m", messages: [] }))).toEqual([])
  })

  test("a client's own defer_loading opt-in survives the read", () => {
    const body = encode({ messages: [], tools: [declared("a", { defer_loading: true })] })
    expect(readDeclaredTools(body)[0]?.defer_loading).toBe(true)
  })
})

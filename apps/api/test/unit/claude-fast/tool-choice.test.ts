import { describe, expect, test } from "bun:test"
import { inspectIntegrity } from "../../../src/providers/claude-fast/integrity"
import { prepareFastRequest, readFastRequest } from "../../../src/providers/claude-fast/request"
import { adaptFastToolChoice } from "../../../src/providers/claude-fast/tool-choice"
import { STRUCTURED_OUTPUT_TOOL } from "../../../src/services/translate/shared/structured-output-anthropic"

const identity = {
  accessToken: "private-token",
  expiresAt: Date.now() + 3600000,
  deviceId: "a".repeat(64),
  accountUuid: "11111111-1111-4111-8111-111111111111",
}
const weather = { name: "weather", input_schema: { type: "object" } }
const search = { name: "search", input_schema: { type: "object" } }
const lookup = { name: "lookup", input_schema: { type: "object" } }
const schema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
}
const structuredTool = { name: STRUCTURED_OUTPUT_TOOL, description: "answer", input_schema: schema }
const base = {
  model: "claude-opus-5-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "hello" }],
}

function prepare(body: object) {
  const result = prepareFastRequest({
    request: readFastRequest(Buffer.from(JSON.stringify(body))),
    model: "claude-opus-5-5",
    identity,
    accountId: "account",
    apiKeyId: "key",
    sessionKey: "session",
  })
  if (!result) throw new Error("missing prepared body")
  return { result, body: JSON.parse(result.text) as Record<string, unknown> }
}

describe("fast-mode tool choice adaptation (pure)", () => {
  test("a forced named tool keeps only that tool, sends auto, and drops thinking disabled", () => {
    const input = {
      ...base,
      tools: [weather, search, lookup],
      tool_choice: { type: "tool", name: "search" },
      thinking: { type: "disabled" },
    }
    const snapshot = JSON.stringify(input)
    const { body, adapted } = adaptFastToolChoice(input)
    expect(adapted).toBe("forced-tool")
    expect(body.tools).toEqual([search])
    expect(body.tool_choice).toEqual({ type: "auto" })
    expect(body).not.toHaveProperty("thinking")
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  test("any keeps every declared tool and sends auto", () => {
    const { body, adapted } = adaptFastToolChoice({
      ...base,
      tools: [weather, search],
      tool_choice: { type: "any" },
    })
    expect(adapted).toBe("forced-tool")
    expect(body.tools).toEqual([weather, search])
    expect(body.tool_choice).toEqual({ type: "auto" })
  })

  test("disable_parallel_tool_use survives the adaptation", () => {
    const { body } = adaptFastToolChoice({
      ...base,
      tools: [weather, search],
      tool_choice: { type: "any", disable_parallel_tool_use: true },
    })
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true })
  })

  test("a thinking block other than disabled is kept", () => {
    const { body } = adaptFastToolChoice({
      ...base,
      tools: [weather],
      tool_choice: { type: "tool", name: "weather" },
      thinking: { type: "adaptive" },
    })
    expect(body.thinking).toEqual({ type: "adaptive" })
  })

  test("auto, none and an absent choice are returned unchanged", () => {
    for (const tool_choice of [{ type: "auto" }, { type: "none" }, undefined] as const) {
      const input = {
        ...base,
        tools: [weather, search],
        ...(tool_choice === undefined ? {} : { tool_choice }),
        thinking: { type: "disabled" },
      }
      const { body, adapted } = adaptFastToolChoice(input)
      expect(adapted).toBeNull()
      expect(body).toBe(input)
    }
  })

  test("an undeclared forced name, or any with no tools, is left for the upstream to refuse", () => {
    for (const input of [
      { ...base, tools: [weather], tool_choice: { type: "tool", name: "missing" } },
      { ...base, tools: [], tool_choice: { type: "any" } },
      { ...base, tool_choice: { type: "any" } },
    ]) {
      const { body, adapted } = adaptFastToolChoice(input)
      expect(adapted).toBeNull()
      expect(body).toBe(input)
    }
  })

  test("the router's structured-output tool becomes native output_config.format", () => {
    const { body, adapted } = adaptFastToolChoice({
      ...base,
      tools: [structuredTool],
      tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL },
      thinking: { type: "disabled" },
    })
    expect(adapted).toBe("structured-output")
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema } })
    expect(body.tools).toEqual([])
    expect(body).not.toHaveProperty("tool_choice")
    expect(body).not.toHaveProperty("thinking")
  })

  test("a structured-output schema Anthropic would refuse natively stays an adapted forced tool", () => {
    const loose = {
      name: STRUCTURED_OUTPUT_TOOL,
      description: "answer",
      input_schema: { type: "object" },
    }
    const { body, adapted } = adaptFastToolChoice({
      ...base,
      tools: [loose],
      tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL },
      thinking: { type: "disabled" },
    })
    expect(adapted).toBe("forced-tool")
    expect(body.tools).toEqual([loose])
    expect(body.tool_choice).toEqual({ type: "auto" })
    expect(body).not.toHaveProperty("thinking")
    expect(body).not.toHaveProperty("output_config")
  })

  test("structured output merges into an existing output_config", () => {
    const { body } = adaptFastToolChoice({
      ...base,
      tools: [structuredTool],
      tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL },
      output_config: { effort: "low" },
    })
    expect(body.output_config).toEqual({
      effort: "low",
      format: { type: "json_schema", schema },
    })
  })
})

describe("fast-mode tool choice adaptation in the prepared body", () => {
  test("the forwarded body carries the narrowed tools, auto, and no thinking disabled", () => {
    const { result, body } = prepare({
      ...base,
      tools: [weather, search],
      tool_choice: { type: "tool", name: "weather" },
      thinking: { type: "disabled" },
    })
    expect(result.forcedTool).toBe("forced-tool")
    expect(body.tools).toEqual([weather])
    expect(body.tool_choice).toEqual({ type: "auto" })
    expect(body).not.toHaveProperty("thinking")
    expect(inspectIntegrity(result.text).matches).toBe(true)
  })

  test("an unforced request prepares exactly as before", () => {
    const input = { ...base, tools: [weather], tool_choice: { type: "auto" } }
    const { result, body } = prepare(input)
    expect(result.forcedTool).toBeNull()
    expect(body.tools).toEqual([weather])
    expect(body.tool_choice).toEqual({ type: "auto" })
  })

  test("structured output is forwarded as output_config.format with no tools", () => {
    const { result, body } = prepare({
      ...base,
      tools: [structuredTool],
      tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL },
      thinking: { type: "disabled" },
    })
    expect(result.forcedTool).toBe("structured-output")
    expect(body.tools).toEqual([])
    expect(body).not.toHaveProperty("tool_choice")
    expect(body).not.toHaveProperty("thinking")
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema } })
  })
})

// 101 finding 10.4: a schema with a keyword Anthropic's native subset refuses is reduced to that
// subset (`anthropic-output-schema.ts`) and goes native, the bound restated as text; it no longer
// costs a 400 or falls back to the tool.
describe("native structured output with a reduced schema", () => {
  const tags = { type: "array", items: { type: "string" }, maxItems: 3 }
  const bounded = {
    type: "object",
    properties: { ok: { type: "boolean" }, tags },
    required: ["ok", "tags"],
    additionalProperties: false,
  }
  const forcedStructured = (input_schema: object) => ({
    ...base,
    tools: [{ name: STRUCTURED_OUTPUT_TOOL, description: "answer", input_schema }],
    tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL },
  })

  test("maxItems goes native, without the keyword, with the bound in the description", () => {
    const drops: string[] = []
    const adapted = adaptFastToolChoice(forcedStructured(bounded), {
      onDrop: (drop) => drops.push(drop.field),
    })
    expect(adapted.adapted).toBe("structured-output")
    const format = (adapted.body.output_config as { format: { schema: Record<string, unknown> } })
      .format
    const sentTags = (format.schema.properties as Record<string, Record<string, unknown>>).tags
    expect(sentTags).not.toHaveProperty("maxItems")
    expect(sentTags?.description).toContain("maxItems: 3")
    expect(adapted.nativeSchema).toBe(format.schema)
    expect(drops).toEqual(["response_format.json_schema.schema.properties.tags.maxItems"])
    // The client's own schema is untouched.
    expect(tags.maxItems).toBe(3)
  })

  test("the prepared body carries the reduced schema natively", () => {
    const { result, body } = prepare(forcedStructured(bounded))
    expect(result.forcedTool).toBe("structured-output")
    const sent = body.output_config as {
      format: { schema: { properties: Record<string, Record<string, unknown>> } }
    }
    expect(sent.format.schema.properties.tags).not.toHaveProperty("maxItems")
    expect(body.tools).toEqual([])
  })

  test("native: false keeps the adapted tool with the client's own schema", () => {
    const adapted = adaptFastToolChoice(forcedStructured(bounded), { native: false })
    expect(adapted.adapted).toBe("forced-tool")
    expect(adapted.body.tools).toEqual([
      { name: STRUCTURED_OUTPUT_TOOL, description: "answer", input_schema: bounded },
    ])
  })

  test("a reduced schema past the complexity budget still rides the tool", () => {
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`p${i}`, { type: "string", maxLength: 9 }]),
    )
    const wide = { type: "object", properties: many, additionalProperties: false }
    expect(adaptFastToolChoice(forcedStructured(wide)).adapted).toBe("forced-tool")
  })
})

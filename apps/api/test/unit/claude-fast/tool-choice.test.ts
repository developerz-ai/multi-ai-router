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

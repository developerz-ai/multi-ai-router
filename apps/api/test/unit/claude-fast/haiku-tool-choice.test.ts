import { expect, test } from "bun:test"
import { inspectIntegrity } from "../../../src/providers/claude-fast/integrity"
import { prepareFastRequest, readFastRequest } from "../../../src/providers/claude-fast/request"
import { adaptFastToolChoice } from "../../../src/providers/claude-fast/tool-choice"
import { STRUCTURED_OUTPUT_TOOL } from "../../../src/services/translate/shared/structured-output-anthropic"

const tools = ["echo", "weather"].map((name) => ({ name, input_schema: { type: "object" } }))
const choices = [
  { type: "any", disable_parallel_tool_use: true },
  { type: "tool", name: "echo" },
]

for (const tool_choice of choices) {
  test(`Haiku 5.5 preserves native ${tool_choice.type} and every declared tool`, () => {
    for (const thinking of [undefined, { type: "disabled" }, { type: "adaptive" }]) {
      const input = { model: "claude-haiku-5-5", tools, tool_choice, thinking }
      const result = adaptFastToolChoice(input)
      expect(result.body).toBe(input)
      expect(result.adapted).toBeNull()
    }
  })
}

test("Haiku leaves incompatible thinking plus force for upstream validation", () => {
  const input = {
    model: "claude-haiku-5-5",
    tools,
    tool_choice: { type: "any" },
    thinking: { type: "enabled", budget_tokens: 1024 },
  }
  expect(adaptFastToolChoice(input).body).toBe(input)
})

test("uncalibrated models retain the existing adaptation", () => {
  for (const model of [
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-fable-5-2",
    "future-model",
  ]) {
    const result = adaptFastToolChoice({ model, tools, tool_choice: { type: "any" } })
    expect(result.body.tool_choice).toEqual({ type: "auto" })
    expect(result.adapted).toBe("forced-tool")
  }
})

test("Haiku's internal structured-output carrier still becomes native JSON", () => {
  const result = adaptFastToolChoice({
    model: "claude-haiku-5-5",
    tools: [
      {
        name: STRUCTURED_OUTPUT_TOOL,
        input_schema: { type: "object", additionalProperties: false },
      },
    ],
    tool_choice: { type: "tool", name: STRUCTURED_OUTPUT_TOOL },
  })
  expect(result.adapted).toBe("structured-output")
  expect(result.body).toHaveProperty("output_config")
})

test("prepared Haiku request retains any and has a valid checksum", () => {
  const input = {
    model: "claude-haiku-5-5",
    max_tokens: 256,
    tools,
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: "Anything you can do." }],
  }
  const result = prepareFastRequest({
    request: readFastRequest(Buffer.from(JSON.stringify(input))),
    model: input.model,
    identity: {
      accessToken: "synthetic",
      expiresAt: 9999999999999,
      deviceId: "a".repeat(64),
      accountUuid: "11111111-1111-4111-8111-111111111111",
    },
    accountId: "account",
    apiKeyId: "key",
    sessionKey: "session",
  })
  expect(result).not.toBeNull()
  if (!result) throw new Error("missing prepared request")
  expect(JSON.parse(result.text).tool_choice).toEqual({ type: "any" })
  expect(result.forcedTool).toBeNull()
  expect(inspectIntegrity(result.text).matches).toBe(true)
})

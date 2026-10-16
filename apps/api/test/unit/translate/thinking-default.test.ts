/**
 * `enable_thinking: false` on a forced-tool openai-chat body bound for a think-by-default model
 * (`services/translate/shared/thinking-default.ts`).
 *
 * Prod, qwen3.8-max (`openai-compatible`, anthropic ingress → openai-chat egress): ~284 upstream
 * `400`s "The tool_choice parameter does not support being set to required or object in thinking
 * mode". The 3.8 hybrid series thinks by default, so dropping a client-sent `thinking`
 * (`reasoning-effort.ts`) is not enough — the model still reasons unless the body states
 * `enable_thinking: false`. Config-driven matcher (`OPENAI_CHAT_THINKING_DEFAULT_MODELS`), vendor
 * dial only, model never changed. Research: `docs/research/thinking-and-tool-choice.md`.
 */
import { describe, expect, test } from "bun:test"
import {
  anthropicToOpenAiChatRequest,
  createThinkingDefaultMatcher,
  disableThinkingDefaultForForcedTool,
} from "../../../src/services/translate"
import { anthropicRequest, anthropicTool } from "./fixtures"

const QWEN_SET = ["qwen3.8-max", "qwen3.8-flash"]

describe("createThinkingDefaultMatcher", () => {
  test("empty config matches nothing (the default)", () => {
    const matches = createThinkingDefaultMatcher([])
    expect(matches("qwen3.8-max")).toBe(false)
  })

  test("exact ids match, others do not", () => {
    const matches = createThinkingDefaultMatcher(QWEN_SET)
    expect(matches("qwen3.8-max")).toBe(true)
    expect(matches("qwen3.8-flash")).toBe(true)
    expect(matches("qwen3-max")).toBe(false)
    expect(matches("gpt-5.5")).toBe(false)
  })

  test("a trailing-* glob matches by prefix", () => {
    const matches = createThinkingDefaultMatcher(["qwen3.8-*"])
    expect(matches("qwen3.8-max")).toBe(true)
    expect(matches("qwen3.8-flash")).toBe(true)
    expect(matches("qwen3-turbo")).toBe(false)
  })

  test("whitespace-only entries are ignored and never widen to match-all", () => {
    const matches = createThinkingDefaultMatcher(["", "   "])
    expect(matches("qwen3.8-max")).toBe(false)
    expect(matches("anything")).toBe(false)
  })
})

const matches = createThinkingDefaultMatcher(QWEN_SET)

function chatBody(toolChoice: unknown): Record<string, unknown> {
  const out = anthropicToOpenAiChatRequest({
    ...anthropicRequest({ tools: [anthropicTool({ name: "json" })], tool_choice: toolChoice }),
  })
  return out as unknown as Record<string, unknown>
}

describe("disableThinkingDefaultForForcedTool", () => {
  // Failure case first: forced tool + matched model must carry the dial (no field on HEAD).
  test("forced tool + model in set -> enable_thinking:false", () => {
    const out = disableThinkingDefaultForForcedTool(
      chatBody({ type: "tool", name: "json" }),
      "qwen3.8-max",
      matches,
    )
    expect(out.enable_thinking).toBe(false)
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "json" } })
  })

  test("forced tool (any) + model in set -> enable_thinking:false", () => {
    const out = disableThinkingDefaultForForcedTool(
      chatBody({ type: "any" }),
      "qwen3.8-flash",
      matches,
    )
    expect(out.enable_thinking).toBe(false)
    expect(out.tool_choice).toBe("required")
  })

  test("forced tool + model NOT in set -> no field", () => {
    const out = disableThinkingDefaultForForcedTool(
      chatBody({ type: "tool", name: "json" }),
      "qwen3-max",
      matches,
    )
    expect("enable_thinking" in out).toBe(false)
  })

  test("auto tool_choice + model in set -> no field (only a forced tool triggers it)", () => {
    const out = disableThinkingDefaultForForcedTool(
      chatBody({ type: "auto" }),
      "qwen3.8-max",
      matches,
    )
    expect("enable_thinking" in out).toBe(false)
  })

  test("no tool_choice at all + model in set -> no field", () => {
    const out = disableThinkingDefaultForForcedTool(chatBody(undefined), "qwen3.8-max", matches)
    expect("enable_thinking" in out).toBe(false)
  })

  test("empty config set -> never injected even for a forced tool", () => {
    const never = createThinkingDefaultMatcher([])
    const out = disableThinkingDefaultForForcedTool(
      chatBody({ type: "tool", name: "json" }),
      "qwen3.8-max",
      never,
    )
    expect("enable_thinking" in out).toBe(false)
  })

  test("the input object is not mutated", () => {
    const body = chatBody({ type: "any" })
    disableThinkingDefaultForForcedTool(body, "qwen3.8-max", matches)
    expect("enable_thinking" in body).toBe(false)
  })
})

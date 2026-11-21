import { describe, expect, test } from "bun:test"
import { CODEX_RESPONSES_EGRESS } from "../../../src/providers/drivers/openai-oauth"
import {
  anthropicToOpenAiResponsesRequest,
  applyResponsesModelDials,
  cachesTopLevelInstructions,
  openAiChatToOpenAiResponsesRequest,
  takesTextVerbosity,
} from "../../../src/services/translate"
import { DEFAULT_RESPONSES_EGRESS } from "../../../src/services/translate/shared/responses-egress"
import { anthropicRequest, openAiChatRequest } from "./fixtures"

/**
 * The two Responses dials decided by the upstream (post-alias) model, on a body the router wrote.
 *
 * 1. GPT-6.2 and later append top-level `instructions` after `input` and bill them uncached on
 *    every request (developers.openai.com/api/docs/guides/prompt-caching.md, read 2026-11-20). The
 *    Anthropic translator put the whole system prompt there, so on a GPT-6.2 tool loop the system
 *    prompt was never a cache read; opencode 2.3.2 measured ~14,000 uncached tokens per step
 *    falling to 3 after moving it to a leading developer message.
 * 2. `text.verbosity: "low"` when the caller stated none — what Codex and opencode send to the
 *    GPT-5/6 family — and the caller's own value whenever it stated one.
 */

const SYSTEM = "you are a careful coding agent"

function translated(model: string): Record<string, unknown> {
  return anthropicToOpenAiResponsesRequest(
    anthropicRequest({ model, system: SYSTEM }),
  ) as unknown as Record<string, unknown>
}

const developer = (text: string) => ({
  type: "message",
  role: "developer",
  content: [{ type: "input_text", text }],
})

describe("system prompt placement for a model that does not cache `instructions`", () => {
  test("gpt-6.2-sol: the system prompt leads `input` as a developer message", () => {
    const out = applyResponsesModelDials(translated("x"), "gpt-6.2-sol", DEFAULT_RESPONSES_EGRESS)
    expect(out.instructions).toBeUndefined()
    expect(out.input).toEqual([
      developer(SYSTEM),
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ])
  })

  test("Codex egress requires the field: `instructions` stays present and empty", () => {
    const out = applyResponsesModelDials(translated("x"), "gpt-6.2-astra", CODEX_RESPONSES_EGRESS)
    expect(out.instructions).toBe("")
    expect((out.input as unknown[])[0]).toEqual(developer(SYSTEM))
  })

  test("an empty or absent prompt adds no developer message", () => {
    for (const instructions of ["", undefined]) {
      const body = { model: "x", input: [], instructions }
      const out = applyResponsesModelDials(body, "gpt-6.2-sol", CODEX_RESPONSES_EGRESS)
      expect(out.input).toEqual([])
    }
  })

  test("gpt-6.1-sol and older keep `instructions` exactly as the translator wrote it", () => {
    for (const model of ["gpt-6.1-sol", "gpt-6-luna", "gpt-5.5", "o3", "claude-opus-5"]) {
      const body = translated("x")
      const out = applyResponsesModelDials(body, model, CODEX_RESPONSES_EGRESS)
      expect(out.instructions).toBe(SYSTEM)
      expect(out.input).toEqual(body.input)
    }
  })

  test("the threshold is the version, so a later release is covered without a new id", () => {
    expect(
      ["gpt-6.2", "gpt-6.2-sol", "gpt-6.3-sol", "gpt-6.10", "gpt-7", "gpt-7.1-luna"].map(
        cachesTopLevelInstructions,
      ),
    ).toEqual([false, false, false, false, false, false])
    expect(
      ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-4.1", "o3", "kimi-k3", "gpt-6.1"].map(
        cachesTopLevelInstructions,
      ),
    ).toEqual([true, true, true, true, true, true, true])
  })
})

describe("text.verbosity", () => {
  test("defaults to low for the GPT-5/6 family when the caller stated none", () => {
    const out = applyResponsesModelDials(translated("x"), "gpt-6.1-sol", CODEX_RESPONSES_EGRESS)
    expect(out.text).toEqual({ verbosity: "low" })
  })

  test("is never sent to a model outside that family, where it can be a 400", () => {
    for (const model of ["gpt-4.1", "o3", "gpt-5-chat-latest", "kimi-k3", "claude-opus-5"]) {
      const out = applyResponsesModelDials(translated("x"), model, DEFAULT_RESPONSES_EGRESS)
      expect(out.text).toBeUndefined()
    }
    expect(
      ["gpt-5", "gpt-5-mini", "gpt-5.4", "gpt-6-luna", "gpt-6.2-sol"].every(takesTextVerbosity),
    ).toBe(true)
  })

  test("an Anthropic caller's `output_config.verbosity` wins over the default", () => {
    const body = anthropicToOpenAiResponsesRequest(
      anthropicRequest({ model: "gpt-6.2-sol", output_config: { verbosity: "high" } }),
    ) as unknown as Record<string, unknown>
    expect(body.text).toEqual({ verbosity: "high" })
    const out = applyResponsesModelDials(body, "gpt-6.2-sol", CODEX_RESPONSES_EGRESS)
    expect(out.text).toEqual({ verbosity: "high" })
  })

  test("an openai-chat caller's `verbosity` is carried as `text.verbosity` beside its format", () => {
    const body = openAiChatToOpenAiResponsesRequest({
      ...openAiChatRequest({ model: "gpt-6.1-sol", response_format: { type: "json_object" } }),
      verbosity: "medium",
    }) as unknown as Record<string, unknown>
    expect(body.text).toEqual({ format: { type: "json_object" }, verbosity: "medium" })
    const out = applyResponsesModelDials(body, "gpt-6.1-sol", CODEX_RESPONSES_EGRESS)
    expect(out.text).toEqual({ format: { type: "json_object" }, verbosity: "medium" })
  })

  test("the default joins a structured-output format rather than replacing it", () => {
    const body = { model: "x", input: [], text: { format: { type: "json_object" } } }
    const out = applyResponsesModelDials(body, "gpt-6-luna", DEFAULT_RESPONSES_EGRESS)
    expect(out.text).toEqual({ format: { type: "json_object" }, verbosity: "low" })
  })
})

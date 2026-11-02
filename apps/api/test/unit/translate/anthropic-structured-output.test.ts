/**
 * Anthropic's own structured-output constraint on the two hops that leave the Anthropic dialect
 * (anthropic → openai-chat, anthropic → openai-responses).
 *
 * `anthropicRequestSchema` is a `z.object`, so it strips every key it does not name — and the
 * constraint was not one of them: `output_config.format` (the field Anthropic's Messages API
 * states on the wire) was dropped with the rest of `output_config`, and `output_format` (the name
 * Anthropic's own SDKs take it under) was dropped outright. The field was therefore gone before
 * any translator saw it: the upstream answered in prose, and the caller's `JSON.parse` failed with
 * nothing naming the cause. A constrained answer is a contract, so it is now refused by name on
 * every hop that cannot carry it. A same-dialect body is relayed untouched (the passthrough never
 * parses it).
 *
 * The two carriers this build does have are untouched: openai-chat's `response_format` onto
 * openai-responses (`text.format`) and onto anthropic (a forced tool call).
 */

import { describe, expect, test } from "bun:test"
import { TranslationError } from "@multi-ai-router/core"
import {
  anthropicToOpenAiChatRequest,
  anthropicToOpenAiResponsesRequest,
} from "../../../src/services/translate"
import { anthropicRequest } from "./fixtures"

/** A schema carrying a marker property, so an assertion can prove no value was quoted back. */
const SCHEMA = {
  type: "object",
  properties: { secret_marker: { type: "string" } },
  required: ["secret_marker"],
}

const FORMAT = { type: "json_schema", schema: SCHEMA }

/** The two request translators, seen through the one signature they share. */
type Translator = (body: unknown) => unknown

const HOPS: readonly (readonly [string, Translator])[] = [
  ["openai-chat", anthropicToOpenAiChatRequest],
  ["openai-responses", anthropicToOpenAiResponsesRequest],
]

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(TranslationError)
    expect((error as TranslationError).status).toBe(400)
    return (error as Error).message
  }
  throw new Error("expected a TranslationError")
}

/** What a translator emitted, read as the plain object every dialect's body is. */
function translated(translate: Translator, body: unknown): Record<string, unknown> {
  return translate(body) as Record<string, unknown>
}

describe("a stated structured-output constraint is refused by name, never dropped", () => {
  for (const [dialect, translate] of HOPS) {
    test(`anthropic → ${dialect}: output_config.format is refused, naming the field`, () => {
      const message = refusal(() =>
        translate(anthropicRequest({ output_config: { format: FORMAT } })),
      )
      expect(message).toContain("output_config.format")
      expect(message).not.toContain("secret_marker")
    })

    test(`anthropic → ${dialect}: output_format, the SDK spelling, is refused the same way`, () => {
      const message = refusal(() => translate(anthropicRequest({ output_format: FORMAT })))
      expect(message).toContain("output_format")
      expect(message).not.toContain("secret_marker")
    })

    test(`anthropic → ${dialect}: a shape this build does not know is still refused by name`, () => {
      const message = refusal(() =>
        translate(anthropicRequest({ output_config: { format: { type: "grammar_xyz" } } })),
      )
      expect(message).toContain("output_config.format")
      expect(message).not.toContain("grammar_xyz")
    })
  }
})

describe("absent and null state nothing, and the request still translates", () => {
  for (const [dialect, translate] of HOPS) {
    test(`anthropic → ${dialect}: a request without the constraint translates`, () => {
      const out = translated(translate, anthropicRequest())
      expect(out.model).toBe("claude-sonnet-4-5")
      expect(Object.keys(out)).not.toContain("output_format")
    })

    test(`anthropic → ${dialect}: output_config.format: null states nothing and translates`, () => {
      const out = translated(translate, anthropicRequest({ output_config: { format: null } }))
      expect(out.model).toBe("claude-sonnet-4-5")
    })

    test(`anthropic → ${dialect}: output_format: null states nothing and translates`, () => {
      const out = translated(translate, anthropicRequest({ output_format: null }))
      expect(out.model).toBe("claude-sonnet-4-5")
      expect(Object.keys(out)).not.toContain("output_format")
    })
  }
})

/** The reasoning dial is the other half of `output_config`, and it is carried, not refused. */
describe("the effort dial beside the constraint is untouched", () => {
  test("anthropic → openai-chat: output_config.effort still becomes reasoning_effort", () => {
    const out = anthropicToOpenAiChatRequest(anthropicRequest({ output_config: { effort: "low" } }))
    expect(out.reasoning_effort).toBe("low")
  })

  test("anthropic → openai-responses: output_config.effort still becomes reasoning.effort", () => {
    const out = anthropicToOpenAiResponsesRequest(
      anthropicRequest({ output_config: { effort: "low" } }),
    )
    expect(out.reasoning).toMatchObject({ effort: "low" })
  })
})

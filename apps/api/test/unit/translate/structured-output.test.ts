import { describe, expect, test } from "bun:test"
import { TranslationError } from "@multi-ai-router/core"
import { CODEX_RESPONSES_EGRESS } from "../../../src/providers"
import {
  openAiChatToOpenAiResponsesRequest,
  openAiResponsesToAnthropicRequest,
  openAiResponsesToOpenAiChatRequest,
  type TranslationContext,
  translationPair,
} from "../../../src/services/translate"
import { DEFAULT_SCHEMA_NAME } from "../../../src/services/translate/shared/structured-output"
import { openAiChatRequest, openAiResponsesRequest } from "./fixtures"

/**
 * Structured output across openai-chat → openai-responses (2.28.0).
 *
 * Production, 2026-10-14: a ChatGPT-subscription account (`openai-oauth`, a Responses upstream)
 * answered `/v1/chat/completions` + `response_format: json_schema` with the router's own `400`
 * "this build translates no structured-output constraint onto another dialect" — while the same
 * schema sent as `/v1/responses` `text.format` came back as the constrained JSON. Responses states
 * the feature, so the constraint is carried; every other crossing still refuses it.
 */

const PERSON_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
  required: ["title", "tags"],
  additionalProperties: false,
}

function chatWith(responseFormat: unknown) {
  return openAiChatRequest({ response_format: responseFormat })
}

function refusal(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(TranslationError)
    return (error as Error).message
  }
  throw new Error("expected a TranslationError")
}

describe("malformed response_format is still a 400 naming the field (never the value)", () => {
  test("json_schema with no json_schema object", () => {
    const message = refusal(() =>
      openAiChatToOpenAiResponsesRequest(chatWith({ type: "json_schema" })),
    )
    expect(message).toContain("response_format.json_schema")
  })

  test("a name OpenAI would refuse: characters outside [a-zA-Z0-9_-]", () => {
    const message = refusal(() =>
      openAiChatToOpenAiResponsesRequest(
        chatWith({ type: "json_schema", json_schema: { name: "secret shape!", schema: {} } }),
      ),
    )
    expect(message).toContain("response_format.json_schema.name")
    expect(message).not.toContain("secret shape")
  })

  test("a name longer than 64 characters, and a non-string name", () => {
    for (const name of ["a".repeat(65), 7, ""]) {
      expect(
        refusal(() =>
          openAiChatToOpenAiResponsesRequest(
            chatWith({ type: "json_schema", json_schema: { name, schema: PERSON_SCHEMA } }),
          ),
        ),
      ).toContain("response_format.json_schema.name")
    }
  })

  test("no schema: Responses requires one and none is invented", () => {
    for (const schema of [undefined, null, "object", [1]]) {
      expect(
        refusal(() =>
          openAiChatToOpenAiResponsesRequest(
            chatWith({ type: "json_schema", json_schema: { name: "person", schema } }),
          ),
        ),
      ).toContain("response_format.json_schema.schema")
    }
  })

  test("a non-boolean strict, a non-string description", () => {
    expect(
      refusal(() =>
        openAiChatToOpenAiResponsesRequest(
          chatWith({
            type: "json_schema",
            json_schema: { name: "p", schema: PERSON_SCHEMA, strict: "yes" },
          }),
        ),
      ),
    ).toContain("response_format.json_schema.strict")
    expect(
      refusal(() =>
        openAiChatToOpenAiResponsesRequest(
          chatWith({
            type: "json_schema",
            json_schema: { name: "p", schema: PERSON_SCHEMA, description: 1 },
          }),
        ),
      ),
    ).toContain("response_format.json_schema.description")
  })

  test("an unknown type is refused, and the free word is not quoted back", () => {
    const message = refusal(() =>
      openAiChatToOpenAiResponsesRequest(chatWith({ type: "grammar_xyz" })),
    )
    expect(message).toContain("response_format.type")
    expect(message).not.toContain("grammar_xyz")
  })

  test("a response_format that is not an object at all", () => {
    expect(refusal(() => openAiChatToOpenAiResponsesRequest(chatWith("json")))).toContain(
      "response_format",
    )
  })
})

describe("response_format → text.format", () => {
  test("json_schema: name, strict, description and schema travel verbatim", () => {
    const out = openAiChatToOpenAiResponsesRequest(
      chatWith({
        type: "json_schema",
        json_schema: {
          name: "chat_title",
          description: "A title",
          strict: true,
          schema: PERSON_SCHEMA,
        },
      }),
    )
    expect(out.text).toEqual({
      format: {
        type: "json_schema",
        name: "chat_title",
        schema: PERSON_SCHEMA,
        strict: true,
        description: "A title",
      },
    })
    const format = out.text?.format
    if (format?.type !== "json_schema") throw new Error("expected json_schema")
    // Byte-faithful: the caller's own schema, key order and all, never a normalized copy.
    expect(JSON.stringify(format.schema)).toBe(JSON.stringify(PERSON_SCHEMA))
  })

  test("strict: false survives; strict: null and an absent description are omitted", () => {
    const loose = openAiChatToOpenAiResponsesRequest(
      chatWith({ type: "json_schema", json_schema: { name: "a", schema: {}, strict: false } }),
    )
    expect(loose.text?.format).toEqual({
      type: "json_schema",
      name: "a",
      schema: {},
      strict: false,
    })
    const unset = openAiChatToOpenAiResponsesRequest(
      chatWith({ type: "json_schema", json_schema: { name: "a", schema: {}, strict: null } }),
    )
    expect(unset.text?.format).toEqual({ type: "json_schema", name: "a", schema: {} })
  })

  test("an omitted name is defaulted, because Responses requires one", () => {
    const out = openAiChatToOpenAiResponsesRequest(
      chatWith({ type: "json_schema", json_schema: { schema: PERSON_SCHEMA, strict: true } }),
    )
    expect(DEFAULT_SCHEMA_NAME).toBe("response")
    expect(out.text?.format).toMatchObject({ type: "json_schema", name: "response", strict: true })
  })

  test("json_object → text.format json_object", () => {
    const out = openAiChatToOpenAiResponsesRequest(chatWith({ type: "json_object" }))
    expect(out.text).toEqual({ format: { type: "json_object" } })
  })

  test("text, null and absent state no constraint", () => {
    for (const responseFormat of [{ type: "text" }, null, undefined]) {
      expect(openAiChatToOpenAiResponsesRequest(chatWith(responseFormat)).text).toBeUndefined()
    }
  })

  test("survives the Codex egress rules, which a ChatGPT account applies", () => {
    const pair = translationPair("openai-chat", "openai-responses")
    if (pair === null) throw new Error("no pair")
    const context: TranslationContext = {
      created: 1,
      model: "gpt-6-luna",
      fallbackId: "req-1",
      responsesEgress: CODEX_RESPONSES_EGRESS,
    }
    const body = pair.request(
      chatWith({
        type: "json_schema",
        json_schema: { name: "chat_title", strict: true, schema: PERSON_SCHEMA },
      }),
      context,
    ) as Record<string, unknown>
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "chat_title", strict: true, schema: PERSON_SCHEMA },
    })
    expect(body.stream).toBe(true)
  })

  test("stop is still refused on this pair: Responses has no stop parameter", () => {
    expect(
      refusal(() =>
        openAiChatToOpenAiResponsesRequest(
          openAiChatRequest({ stop: ["\n"], response_format: { type: "json_object" } }),
        ),
      ),
    ).toContain("stop")
  })
})

describe("every crossing that cannot carry structured output still refuses it (openai-chat → anthropic carries it: structured-output-anthropic.test.ts)", () => {
  test("openai-responses → openai-chat and → anthropic: text.format", () => {
    for (const format of [
      { type: "json_schema", name: "p", schema: {} },
      { type: "json_object" },
    ]) {
      const request = openAiResponsesRequest({ text: { format } })
      expect(refusal(() => openAiResponsesToOpenAiChatRequest(request))).toContain(
        "text.format.type",
      )
      expect(refusal(() => openAiResponsesToAnthropicRequest(request))).toContain(
        "text.format.type",
      )
    }
  })
})

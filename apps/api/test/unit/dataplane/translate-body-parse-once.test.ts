/**
 * The schema parse is spent once per request, not once per target shape (06.2). Two candidates
 * wanting different shapes — here two openai-chat output-ceiling spellings — convert from the same
 * parsed value; a malformed body is still a `400` naming its deepest field.
 */

import { expect, test } from "bun:test"
import { TranslationError } from "@multi-ai-router/core"
import { createTranslatedRequestBody } from "../../../src/services/dataplane"
import type { TranslationContext, TranslationPair } from "../../../src/services/translate"
import type { ParsedIngressRequest } from "../../../src/services/translate/parse-ingress"
import { translationPair } from "../../../src/services/translate/registry"

const CONTEXT: TranslationContext = { created: 1, model: "m", fallbackId: "req-1" }

function realPair(): TranslationPair {
  const pair = translationPair("anthropic", "openai-chat")
  if (pair === null) throw new Error("pair missing")
  return pair
}

function encode(body: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(body))
}

const BODY = {
  model: "m",
  max_tokens: 64,
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
}

test("two target shapes convert from one parse", () => {
  const real = realPair()
  const seen: ParsedIngressRequest[] = []
  const pair: TranslationPair = {
    ...real,
    requestFromParsed: (parsed, context) => {
      seen.push(parsed)
      return real.requestFromParsed?.(parsed, context)
    },
  }
  const translated = createTranslatedRequestBody(encode(BODY), CONTEXT)
  translated.bodyFor(pair, "a", "max_tokens")
  translated.bodyFor(pair, "b", "max_completion_tokens")
  expect(seen).toHaveLength(2)
  expect(seen[0]).toBe(seen[1] as ParsedIngressRequest)
})

test("a malformed body is a 400 naming the deepest field", () => {
  const translated = createTranslatedRequestBody(
    encode({
      ...BODY,
      messages: [{ role: "assistant", content: [{ type: "tool_use", name: "f", input: {} }] }],
    }),
    CONTEXT,
  )
  expect(() => translated.bodyFor(realPair(), "a", "max_tokens")).toThrow(TranslationError)
  expect(() => translated.bodyFor(realPair(), "a", "max_tokens")).toThrow(
    "`messages.0.content.0.id`",
  )
})

test("a stand-in pair without requestFromParsed still converts through request", () => {
  const pair = {
    ...realPair(),
    requestFromParsed: undefined,
    request: () => ({ model: "x", ok: true }),
  } as TranslationPair
  const out = createTranslatedRequestBody(encode(BODY), CONTEXT).bodyFor(pair, "a", "max_tokens")
  expect(JSON.parse(new TextDecoder().decode(out)).ok).toBe(true)
})

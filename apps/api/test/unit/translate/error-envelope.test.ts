import { describe, expect, test } from "bun:test"
import type { Dialect } from "@multi-ai-router/core"
import { translationPair } from "../../../src/services/translate/registry"

const dialects: readonly Dialect[] = ["anthropic", "openai-chat", "openai-responses"]
const context = { created: 1, model: "test", fallbackId: "test" }

describe("recognized successful-status error envelopes", () => {
  for (const egress of dialects) {
    for (const ingress of dialects) {
      if (egress === ingress) continue
      test(`${egress} error remains an error toward ${ingress}`, () => {
        const pair = translationPair(ingress, egress)
        expect(pair).not.toBeNull()
        if (!pair) throw new Error("Missing pair")
        const payload = {
          error: { message: "Provider unavailable", type: "server_error" },
          ...(egress === "anthropic" ? { type: "error" } : {}),
          ...(egress === "openai-responses" ? { status: "failed" } : {}),
        }
        const result = pair.response(payload, context)
        expect(result.body).toMatchObject({ error: { message: "Provider unavailable" } })
        expect(result.unrecognizedStopReason).toBeNull()
        expect(result.body).not.toHaveProperty("choices")
        expect(result.body).not.toHaveProperty("content")
        expect(result.body).not.toHaveProperty("output")
      })
    }
  }
  test("null or array error metadata does not override a valid Chat completion", () => {
    const pair = translationPair("anthropic", "openai-chat")
    if (!pair) throw new Error("Missing pair")
    for (const error of [null, []]) {
      expect(
        pair.response(
          { error, choices: [{ message: { content: "Answer" }, finish_reason: "stop" }] },
          context,
        ).body,
      ).toMatchObject({ content: [{ type: "text", text: "Answer" }] })
    }
  })
})

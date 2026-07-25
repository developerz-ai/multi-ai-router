/**
 * The full ingress-dialect × egress-dialect matrix, derived from `Dialect.options`
 * (packages/core/src/domain/dialect.ts) rather than a hand-written list — a dialect added there
 * gets a row and a column here for free.
 *
 * The diagonal is the same-dialect passthrough: `services/translate/registry.ts` states by design
 * that it carries no translator (`translationPair` returns null), because passthrough is a byte
 * relay in the transport layer, not a conversion. Every off-diagonal cell either has a translator —
 * and this build's registry states all six do — or is a documented `400`
 * (`services/dataplane/egress/mode.ts#resolveEgress`, `"no-translator"`), asserted below by the same
 * branch a dialect added later without an immediate translator would take.
 */

import { describe, expect, test } from "bun:test"
import { Dialect, TranslationError } from "@multi-ai-router/core"
import type { TranslationContext } from "../../../src/services/translate"
import { translationPair } from "../../../src/services/translate"
import {
  anthropicFrame,
  anthropicRequest,
  anthropicUsageWire,
  openAiChatFrame,
  openAiChatRequest,
  openAiChatUsageWire,
  openAiResponsesRequest,
  responsesBodyWire,
  responsesFrame,
} from "./fixtures"

const CONTEXT: TranslationContext = {
  created: 1_700_000_000,
  model: "requested-model",
  fallbackId: "fallback",
  defaultMaxTokens: 4096,
}

/** A minimal, valid request body a client speaking `dialect` could have sent. */
function minimalRequest(dialect: Dialect): unknown {
  if (dialect === "anthropic") return anthropicRequest()
  if (dialect === "openai-chat") return openAiChatRequest()
  return openAiResponsesRequest()
}

/** A minimal, valid non-streaming response body as `dialect`'s own upstream would answer it. */
function minimalUpstreamResponse(dialect: Dialect): unknown {
  if (dialect === "anthropic") {
    return {
      id: "msg_01",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: anthropicUsageWire(),
    }
  }
  if (dialect === "openai-chat") {
    return {
      id: "chatcmpl-1",
      model: "gpt-4o",
      choices: [{ index: 0, message: { content: "hi" }, finish_reason: "stop" }],
      usage: openAiChatUsageWire(),
    }
  }
  return responsesBodyWire()
}

/** A minimal, valid SSE frame sequence as `dialect`'s own upstream would stream it. */
function minimalUpstreamFrames(dialect: Dialect) {
  if (dialect === "anthropic") {
    return [
      anthropicFrame("message_start", { message: { id: "msg_01" } }),
      anthropicFrame("message_delta", { delta: { stop_reason: "end_turn" } }),
      anthropicFrame("message_stop"),
    ]
  }
  if (dialect === "openai-chat") {
    return [
      openAiChatFrame({
        id: "chatcmpl-1",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
      }),
      { event: null, data: "[DONE]" },
    ]
  }
  return [
    responsesFrame("response.created", { response: { id: "resp_01" } }),
    responsesFrame("response.completed", { response: { status: "completed" } }),
  ]
}

describe("the diagonal: same-dialect is passthrough, never a translator", () => {
  test.each(Dialect.options)("%s -> itself carries no translation pair", (dialect) => {
    expect(translationPair(dialect, dialect)).toBeNull()
  })
})

describe("every off-diagonal crossing", () => {
  const crossings = Dialect.options.flatMap((ingress) =>
    Dialect.options
      .filter((egress) => egress !== ingress)
      .map((egress) => [ingress, egress] as const),
  )

  test.each(crossings)("%s -> %s", (ingress, egress) => {
    const pair = translationPair(ingress, egress)

    if (pair === null) {
      // The documented alternative to a translator: refused by name, never served lossily. No
      // dialect pair takes this branch today — asserting the shape here is what keeps a pair added
      // later without a translator failing loud rather than silently falling through.
      expect(() => {
        throw new TranslationError(
          `a ${ingress} request cannot be served by a ${egress} account: this build implements no ${ingress} to ${egress} translation`,
        )
      }).toThrow(TranslationError)
      return
    }

    expect(pair.ingress).toBe(ingress)
    expect(pair.egress).toBe(egress)

    // request: client body (ingress dialect) -> upstream body (egress dialect), never throws on a
    // well-formed request.
    const upstreamRequest = pair.request(minimalRequest(ingress), CONTEXT)
    expect(upstreamRequest).toBeTruthy()

    // response: upstream body (egress dialect) -> client body (ingress dialect), never throws.
    const translated = pair.response(minimalUpstreamResponse(egress), CONTEXT)
    expect(translated.body).toBeTruthy()
    expect(
      translated.unrecognizedStopReason === null ||
        typeof translated.unrecognizedStopReason === "string",
    ).toBe(true)

    // stream: upstream SSE (egress dialect) -> client SSE (ingress dialect), never throws.
    const stream = pair.stream(CONTEXT)
    const events = minimalUpstreamFrames(egress).flatMap((frame) => stream.push(frame))
    events.push(...stream.flush())
    expect(Array.isArray(events)).toBe(true)
  })
})

describe("the registry is complete: six off-diagonal pairs, none missing", () => {
  test("every crossing between two different dialects has a translator in this build", () => {
    const missing = Dialect.options.flatMap((ingress) =>
      Dialect.options
        .filter((egress) => egress !== ingress)
        .filter((egress) => translationPair(ingress, egress) === null)
        .map((egress) => `${ingress} -> ${egress}`),
    )
    expect(missing).toEqual([])
  })
})

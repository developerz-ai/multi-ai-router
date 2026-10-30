import { describe, expect, test } from "bun:test"
import { TranslationError } from "@multi-ai-router/core"
import {
  createReasoningSealer,
  type ReasoningSeal,
} from "../../../src/services/crypto/reasoning-seal"
import { createTranslatedRequestBody } from "../../../src/services/dataplane"
import type { TranslationContext, TranslationPair } from "../../../src/services/translate"

/**
 * The lazy conversion cache: parsed at most once, converted at most once per **target shape**, and
 * the model re-applied on every attempt.
 *
 * The shape — not the dialect — is the key, because two openai-chat accounts can want the output
 * ceiling under different names (`OpenAiChatCeiling`). Keyed by dialect alone, the second account in
 * a chain would silently be handed the first one's body.
 */

const CONTEXT: TranslationContext = {
  created: 1_700_000_000,
  model: "claude-opus-5",
  fallbackId: "req-1",
}

interface Recorded {
  readonly pair: TranslationPair
  readonly calls: TranslationContext[]
}

/** A pair that records what it was asked, and echoes the ceiling it was handed into its body. */
function recordingPair(egress: TranslationPair["egress"] = "openai-chat"): Recorded {
  const calls: TranslationContext[] = []
  const pair = {
    ingress: "anthropic",
    egress,
    request: (_body: unknown, context: TranslationContext) => {
      calls.push(context)
      return { model: "ignored", ceiling: context.chatCeiling ?? null }
    },
    response: () => {
      throw new Error("not used")
    },
    stream: () => {
      throw new Error("not used")
    },
  } as unknown as TranslationPair
  return { pair, calls }
}

function decode(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
}

const SOURCE = new TextEncoder().encode(JSON.stringify({ model: "claude-opus-5", max_tokens: 64 }))

describe("createTranslatedRequestBody", () => {
  test("converts once for a chain of accounts that want the same shape", () => {
    const { pair, calls } = recordingPair()
    const translated = createTranslatedRequestBody(SOURCE, CONTEXT)

    translated.bodyFor(pair, "gpt-4o", "max_tokens")
    translated.bodyFor(pair, "gpt-4o-mini", "max_tokens")

    expect(calls).toHaveLength(1)
  })

  test("converts again for an account that wants the other ceiling, and hands each its own", () => {
    const { pair, calls } = recordingPair()
    const translated = createTranslatedRequestBody(SOURCE, CONTEXT)

    const first = decode(translated.bodyFor(pair, "gpt-5", "max_completion_tokens"))
    const second = decode(translated.bodyFor(pair, "grok-4", "max_tokens"))

    expect(calls.map((call) => call.chatCeiling)).toEqual(["max_completion_tokens", "max_tokens"])
    expect(first.ceiling).toBe("max_completion_tokens")
    expect(second.ceiling).toBe("max_tokens")
  })

  test("two Responses surfaces that differ only in stripLookaroundPatterns convert separately", () => {
    const { pair, calls } = recordingPair("openai-responses")
    const translated = createTranslatedRequestBody(SOURCE, CONTEXT)
    const base = {
      requireStream: true,
      requireInstructions: true,
      unsupportedFields: ["temperature"],
    }

    translated.bodyFor(pair, "gpt-6-luna", undefined, undefined, {
      ...base,
      stripLookaroundPatterns: true,
    })
    translated.bodyFor(pair, "gpt-6-luna", undefined, undefined, {
      ...base,
      stripLookaroundPatterns: false,
    })

    expect(calls.map((call) => call.responsesEgress?.stripLookaroundPatterns)).toEqual([
      true,
      false,
    ])
  })

  test("and back again off the cache: the first shape is not evicted by the second", () => {
    const { pair, calls } = recordingPair()
    const translated = createTranslatedRequestBody(SOURCE, CONTEXT)

    translated.bodyFor(pair, "gpt-5", "max_completion_tokens")
    translated.bodyFor(pair, "grok-4", "max_tokens")
    const again = decode(translated.bodyFor(pair, "gpt-5", "max_completion_tokens"))

    expect(calls).toHaveLength(2)
    expect(again.ceiling).toBe("max_completion_tokens")
  })

  test("the model is re-applied per attempt, after the conversion and whatever it emitted", () => {
    const { pair } = recordingPair()
    const translated = createTranslatedRequestBody(SOURCE, CONTEXT)

    expect(decode(translated.bodyFor(pair, "gpt-4o", "max_tokens")).model).toBe("gpt-4o")
    expect(decode(translated.bodyFor(pair, "gpt-4o-mini", "max_tokens")).model).toBe("gpt-4o-mini")
  })

  test("a body that is not JSON is a TranslationError, before any upstream call", () => {
    const { pair } = recordingPair()
    const translated = createTranslatedRequestBody(new TextEncoder().encode("<html>"), CONTEXT)

    expect(() => translated.bodyFor(pair, "gpt-4o", "max_tokens")).toThrow(TranslationError)
  })

  test("an empty body is a TranslationError naming that there is nothing to translate", () => {
    const { pair } = recordingPair()
    const translated = createTranslatedRequestBody(new Uint8Array(), CONTEXT)

    expect(() => translated.bodyFor(pair, "gpt-4o", "max_tokens")).toThrow(TranslationError)
  })
})

describe("reasoning seal: bound to the selected account", () => {
  const sealer = createReasoningSealer(Buffer.alloc(32, 7).toString("base64"))
  const sealFor = (accountId: string) => ({ accountId, seal: sealer.forAccount(accountId) })

  test("the conversion is handed the selected account's seal", () => {
    const { pair, calls } = recordingPair("openai-responses")
    const translated = createTranslatedRequestBody(SOURCE, CONTEXT)
    translated.bodyFor(pair, "gpt-5", "max_tokens", undefined, undefined, undefined, sealFor("a"))
    const handed = (calls[0] as { reasoningSeal?: ReasoningSeal }).reasoningSeal
    expect(handed?.open(sealer.forAccount("a").seal("blob"))).toBe("blob")
  })

  test("a sealed conversion is never shared across accounts", () => {
    const { pair, calls } = recordingPair("openai-responses")
    const translated = createTranslatedRequestBody(SOURCE, CONTEXT)
    translated.bodyFor(pair, "gpt-5", "max_tokens", undefined, undefined, undefined, sealFor("a"))
    translated.bodyFor(pair, "gpt-5", "max_tokens", undefined, undefined, undefined, sealFor("b"))
    translated.bodyFor(pair, "gpt-5", "max_tokens", undefined, undefined, undefined, sealFor("a"))
    expect(calls).toHaveLength(2)
  })

  test("without a seal, accounts of one shape still share one conversion", () => {
    const { pair, calls } = recordingPair("openai-responses")
    const translated = createTranslatedRequestBody(SOURCE, CONTEXT)
    translated.bodyFor(pair, "gpt-5", "max_tokens")
    translated.bodyFor(pair, "gpt-5", "max_tokens")
    expect(calls).toHaveLength(1)
  })
})

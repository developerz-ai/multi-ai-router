import { describe, expect, test } from "bun:test"
import { catalogEntry, lookupContextWindow } from "../../../src/services/models"

/**
 * How a catalog row gets its two numbers, and the rule that keeps the provenance label honest.
 *
 * The label is the point. A context window from the provider's own listing and one from a table
 * this image was built with are both real published figures, but only one of them can know about a
 * model released last week — so a reader has to be able to tell them apart, and a row assembled
 * from both sources at once cannot be labelled at all.
 */

describe("turning an upstream listing entry into a catalog row", () => {
  test("a listing that states a window wins outright, and is labelled as the upstream's", () => {
    const row = catalogEntry("zai", {
      id: "glm-4.6",
      contextTokens: 999_999,
      maxOutputTokens: 4_096,
    })

    // 999_999 is deliberately not the shipped number: a live reading beats a built-in one even
    // when they disagree, because disagreement is what a refresh is *for*.
    expect(row).toEqual({
      modelId: "glm-4.6",
      contextTokens: 999_999,
      maxOutputTokens: 4_096,
      contextSource: "upstream",
      listingSource: "upstream",
      resolvedModel: null,
    })
  })

  /** The rule that makes `contextSource` answerable at all. */
  test("a row is sourced whole: a live window does not borrow a shipped output ceiling", () => {
    const shipped = lookupContextWindow("zai", "glm-4.6")
    expect(shipped?.maxOutputTokens).toBe(131_072)

    const row = catalogEntry("zai", {
      id: "glm-4.6",
      contextTokens: 204_800,
      maxOutputTokens: null,
    })

    // The shipped ceiling is right there and is deliberately not used. Mixing would produce a row
    // whose window came from one place and whose ceiling came from another — and one label.
    expect(row.maxOutputTokens).toBeNull()
    expect(row.contextSource).toBe("upstream")
  })

  test("a bare listing falls back to the shipped table, and says so", () => {
    // The verified shape of z.ai's real answer: an id, an object type, an owner, no size at all.
    const row = catalogEntry("zai", { id: "glm-5.2", contextTokens: null, maxOutputTokens: null })

    expect(row).toEqual({
      modelId: "glm-5.2",
      contextTokens: 1_048_576,
      maxOutputTokens: 131_072,
      contextSource: "shipped",
      listingSource: "upstream",
      resolvedModel: null,
    })
  })

  test("a model in neither is kept as unknown rather than dropped or defaulted", () => {
    const row = catalogEntry("zai", {
      id: "glm-99-unreleased",
      contextTokens: null,
      maxOutputTokens: null,
    })

    // Nulls, not zeros: a client reading a missing window as unlimited builds a request the
    // upstream rejects. That this router can reach the model is still worth stating.
    expect(row).toEqual({
      modelId: "glm-99-unreleased",
      contextTokens: null,
      maxOutputTokens: null,
      contextSource: null,
      listingSource: "upstream",
      resolvedModel: null,
    })
  })

  test("an output ceiling with no window beside it is still the upstream's word", () => {
    const row = catalogEntry("openai-compatible", {
      id: "whatever-the-operator-pointed-at",
      contextTokens: null,
      maxOutputTokens: 8_192,
    })

    expect(row.maxOutputTokens).toBe(8_192)
    expect(row.contextSource).toBe("upstream")
  })
})

describe("the shipped context table", () => {
  test("a dated snapshot resolves to its family, the way the price table does", () => {
    expect(lookupContextWindow("anthropic-api", "claude-sonnet-4-5-20250929")).toEqual(
      lookupContextWindow("anthropic-api", "claude-sonnet-4-5") ?? {},
    )
  })

  test("a subscription reads the same windows as the API — it is the same model", () => {
    expect(lookupContextWindow("anthropic-oauth", "claude-opus-5")).toEqual({
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    })
  })

  /**
   * The trap the table exists to avoid. Deriving a size from a family prefix would give Opus 4.5
   * and Haiku 4.5 the million-token window their newer siblings carry, overstating both by five
   * times — and a `-chat` variant of a 400k OpenAI model by four.
   */
  test("models left behind by a family's widening keep their own smaller window", () => {
    expect(lookupContextWindow("anthropic-api", "claude-opus-4-5")?.contextTokens).toBe(200_000)
    expect(lookupContextWindow("anthropic-api", "claude-opus-4-6")?.contextTokens).toBe(1_000_000)
    expect(lookupContextWindow("openai-api", "gpt-5.2")?.contextTokens).toBe(400_000)
    expect(lookupContextWindow("openai-api", "gpt-5.2-chat")?.contextTokens).toBe(128_000)
  })

  test("a provider whose listing states its own sizes ships no table to go stale", () => {
    // Google and Mistral answer with `inputTokenLimit` / `max_context_length`, so a shipped row
    // would only ever be a staler copy of a number the parser already reads.
    expect(lookupContextWindow("gemini", "gemini-3.5-flash")).toBeNull()
    expect(lookupContextWindow("mistral", "mistral-large")).toBeNull()
    // The operator's own endpoint: a window for something this router has never seen is a fiction.
    expect(lookupContextWindow("openai-compatible", "anything")).toBeNull()
    expect(lookupContextWindow("ollama", "llama3")).toBeNull()
  })

  /**
   * MiniMax lists both tiers and the table states both. A suffix-stripping normalizer would be an
   * inference; a row is a fact.
   */
  test("MiniMax's highspeed tier is stated rather than inferred from its base model", () => {
    expect(lookupContextWindow("minimax", "MiniMax-M2.5-highspeed")).toEqual({
      contextTokens: 204_800,
      maxOutputTokens: 196_608,
    })
  })
})

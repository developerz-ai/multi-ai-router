import { describe, expect, test } from "bun:test"
import { ProviderId } from "@multi-ai-router/core"
import {
  dialectChoices,
  NAMED_PROVIDER_IDS,
  providerCredentialNote,
  providerDisplayName,
} from "../../src/lib/provider-display"

describe("providerDisplayName", () => {
  test("names every provider core declares — the drift gate", () => {
    expect([...NAMED_PROVIDER_IDS].sort()).toEqual([...ProviderId.options].sort())
  })

  test("falls back to the id for a provider this build does not know", () => {
    expect(providerDisplayName("anthropic-oauth")).toBe("Claude subscriptions")
    expect(providerDisplayName("from-the-future")).toBe("from-the-future")
    expect(providerDisplayName("toString")).toBe("toString")
  })
})

describe("dialectChoices", () => {
  const provider = {
    nativeDialect: "openai-chat",
    supportedDialects: ["anthropic", "openai-chat", "openai-responses"],
  } as const

  test("the default names the surface it resolves to", () => {
    expect(dialectChoices(provider)[0]).toEqual({
      value: "",
      label: "Provider default — OpenAI Chat Completions",
    })
  })

  test("every surface keeps its wire value and reads as a name", () => {
    expect(dialectChoices(provider).slice(1)).toEqual([
      { value: "anthropic", label: "Anthropic Messages (anthropic)" },
      { value: "openai-chat", label: "OpenAI Chat Completions (openai-chat)" },
      { value: "openai-responses", label: "OpenAI Responses (openai-responses)" },
    ])
  })

  test("an unknown provider offers only the default", () => {
    expect(dialectChoices(undefined)).toEqual([{ value: "", label: "Provider default" }])
  })
})

describe("providerCredentialNote", () => {
  test("opencode-go states the personal-key rule", () => {
    expect(providerCredentialNote("opencode-go")).toContain("personal key")
  })

  test("a provider with nothing to say says nothing, whatever its name", () => {
    expect(providerCredentialNote("zai")).toBeNull()
    expect(providerCredentialNote("toString")).toBeNull()
  })
})

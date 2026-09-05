import { describe, expect, test } from "bun:test"
import { ProviderId } from "@multi-ai-router/core"
import { NAMED_PROVIDER_IDS, providerDisplayName } from "../../src/lib/provider-display"

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

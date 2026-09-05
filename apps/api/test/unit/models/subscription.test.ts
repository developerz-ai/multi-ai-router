import { describe, expect, test } from "bun:test"
import { CLAUDE_SUBSCRIPTION_ALIASES, CLAUDE_SUBSCRIPTION_MODELS } from "@multi-ai-router/core"
import {
  listableModels,
  mergeResolution,
  shippedSubscriptionCatalog,
  shippedSubscriptionModels,
  subscriptionCatalog,
} from "../../../src/services/models"
import type { AccountSnapshot } from "../../../src/services/routing"

/**
 * The pure half of a subscription's catalog: how the SDK's answer and the shipped table become
 * rows, which of them `GET /v1/models` lists, and whose word wins on what an alias means.
 */

function snapshot(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    id: "sub-1",
    label: "sub-1",
    provider: "anthropic-oauth",
    status: "active",
    weight: 100,
    priority: 0,
    ...overrides,
  }
}

describe("building a subscription's catalog rows", () => {
  test("a live listing is written as it came, labelled live, sized by what it resolves to", () => {
    const rows = subscriptionCatalog([
      { id: "claude-haiku-4-5", resolvedModel: null, displayName: "Haiku" },
      { id: "haiku", resolvedModel: "claude-haiku-4-5", displayName: "Haiku (latest)" },
    ])

    expect(rows).toEqual([
      {
        modelId: "claude-haiku-4-5",
        contextTokens: 200_000,
        maxOutputTokens: 64_000,
        // The SDK states no size, so the numbers are the shipped table's — and say so.
        contextSource: "shipped",
        listingSource: "live",
        resolvedModel: null,
      },
      {
        modelId: "haiku",
        // The window of `haiku` is the window of whatever `haiku` is today.
        contextTokens: 200_000,
        maxOutputTokens: 64_000,
        contextSource: "shipped",
        listingSource: "live",
        resolvedModel: "claude-haiku-4-5",
      },
    ])
  })

  test("the SDK's own resolution beats the shipped alias map", () => {
    const [row] = subscriptionCatalog([
      { id: "sonnet", resolvedModel: "claude-sonnet-6", displayName: null },
    ])
    expect(row?.resolvedModel).toBe("claude-sonnet-6")
    // Unknown to this image: no window rather than the wrong one.
    expect(row?.contextTokens).toBeNull()
    expect(row?.contextSource).toBeNull()
  })

  test("an alias the SDK listed without resolving falls back to the shipped map", () => {
    const [row] = subscriptionCatalog([{ id: "opus", resolvedModel: null, displayName: null }])
    expect(row?.resolvedModel).toBe(CLAUDE_SUBSCRIPTION_ALIASES.opus)
  })

  test("the shipped fallback is every shipped model plus every alias, labelled shipped", () => {
    const rows = shippedSubscriptionCatalog()

    expect(rows.map((row) => row.modelId)).toEqual([
      ...CLAUDE_SUBSCRIPTION_MODELS,
      ...Object.keys(CLAUDE_SUBSCRIPTION_ALIASES),
    ])
    expect(rows.every((row) => row.listingSource === "shipped")).toBe(true)
    expect(rows.find((row) => row.modelId === "fable")?.resolvedModel).toBe("claude-fable-5-1")
    expect(rows.find((row) => row.modelId === "sonnet")?.resolvedModel).toBe("claude-sonnet-5")
    // Every shipped model has a shipped window — a fallback with unknown sizes would be half a row.
    expect(rows.every((row) => row.contextTokens !== null)).toBe(true)
  })

  test("aliases resolve to the latest of each family", () => {
    expect(CLAUDE_SUBSCRIPTION_ALIASES).toEqual({
      fable: "claude-fable-5-1",
      opus: "claude-opus-5",
      sonnet: "claude-sonnet-5",
      haiku: "claude-haiku-4-5",
    })
  })
})

describe("what an account contributes to GET /v1/models", () => {
  test("a subscription with no catalog rows yet lists the shipped table", () => {
    const listed = listableModels(snapshot(), [])

    expect(listed.map((model) => model.id)).toEqual(
      shippedSubscriptionModels().map((model) => model.id),
    )
    expect(listed.find((model) => model.id === "sonnet")).toEqual({
      id: "sonnet",
      resolvedModel: "claude-sonnet-5",
    })
    expect(listed.find((model) => model.id === "claude-opus-5")?.resolvedModel).toBeNull()
  })

  test("a swept subscription lists its rows first, the live word wins, and the shipped aliases stay listed", () => {
    const rows = shippedSubscriptionModels()
    const live = [
      { ...rows[0], id: "claude-opus-5", listingSource: "live" as const },
      {
        ...rows[0],
        id: "sonnet",
        listingSource: "live" as const,
        resolvedModel: "claude-sonnet-6",
      },
      // What the CLI actually reports for a 1M-context plan: a suffixed alias the shipped table
      // never spells, listed as it came.
      { ...rows[0], id: "opus[1m]", listingSource: "live" as const, resolvedModel: "claude-opus-5[1m]" },
    ]
    const listed = listableModels(snapshot(), live)
    const byId = new Map(listed.map((model) => [model.id, model.resolvedModel]))

    // Live rows come first and their resolution is the one shown.
    expect(listed.slice(0, 3).map((model) => model.id)).toEqual(["claude-opus-5", "sonnet", "opus[1m]"])
    expect(byId.get("sonnet")).toBe("claude-sonnet-6")
    expect(byId.get("opus[1m]")).toBe("claude-opus-5[1m]")
    // The shipped family aliases and canonical ids the handshake did not spell are still there —
    // a client typing `--model opus` or `fable` must find it — each resolving to the latest family member.
    expect(byId.get("opus")).toBe("claude-opus-5")
    expect(byId.get("fable")).toBe("claude-fable-5-1")
    expect(byId.get("haiku")).toBe("claude-haiku-4-5")
    expect(byId.has("claude-sonnet-5")).toBe(true)
    // Nothing is listed twice.
    expect(new Set(listed.map((model) => model.id)).size).toBe(listed.length)
  })

  test("an operator's declared model set narrows a subscription exactly as it narrows any account", () => {
    const listed = listableModels(snapshot({ supportedModels: ["claude-opus-5"] }), [])
    expect(listed.map((model) => model.id)).toEqual(["claude-opus-5"])
  })

  test("routing's own alias map is advertised with what it resolves to, on every provider", () => {
    const listed = listableModels(
      snapshot({ provider: "zai", modelAliases: { sonnet: "glm-4.7" } }),
      [],
    )
    expect(listed).toEqual([{ id: "sonnet", resolvedModel: "glm-4.7" }])
  })

  test("an HTTP passthrough account's catalog rows stay off the wire listing", () => {
    // The documented asymmetry: discovered models go on /v1/catalog until the operator promotes
    // them with the discover button. Only a subscription — which has no such button — lists them.
    const rows = shippedSubscriptionModels()
    expect(listableModels(snapshot({ provider: "anthropic-api" }), rows)).toEqual([])
  })

  test("across accounts the first known resolution wins and a known one beats an unknown one", () => {
    expect(mergeResolution(null, "claude-sonnet-5")).toBe("claude-sonnet-5")
    expect(mergeResolution("claude-sonnet-5", "claude-sonnet-6")).toBe("claude-sonnet-5")
    expect(mergeResolution(null, null)).toBeNull()
  })
})

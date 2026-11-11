import { describe, expect, test } from "bun:test"
import type { ModelDescriptor } from "@multi-ai-router/core"
import { listableModels, shippedSubscriptionModels } from "../../../src/services/models"
import { subscriptionAccount } from "../dataplane/fixtures"

/**
 * Sweep 101, 04.7. `GET /v1/models` rebuilt ~35 shipped rows, two lookups and up to three
 * `resolveModel` calls per name for every in-scope subscription on every request. Both inputs are
 * replaced wholesale on refresh, so identity is their version.
 */

const row = (id: string): ModelDescriptor => ({
  id,
  contextTokens: 200_000,
  maxOutputTokens: 64_000,
  contextSource: "upstream",
  listingSource: "upstream",
  resolvedModel: null,
})

describe("listableModels memo", () => {
  test("the same snapshot and rows answer the same array", () => {
    const { snapshot } = subscriptionAccount("s1")
    const rows = [row("claude-sonnet-5")]

    const first = listableModels(snapshot, rows)
    expect(first.length).toBeGreaterThan(0)
    expect(listableModels(snapshot, rows)).toBe(first)
  })

  test("a refreshed rows array, or a new snapshot, recomputes", () => {
    const { snapshot } = subscriptionAccount("s1")
    const first = listableModels(snapshot, [row("claude-sonnet-5")])

    expect(listableModels(snapshot, [row("claude-sonnet-5")])).not.toBe(first)
    expect(listableModels({ ...snapshot }, [row("claude-sonnet-5")])).not.toBe(first)
  })

  test("the shipped table is built once", () => {
    expect(shippedSubscriptionModels()).toBe(shippedSubscriptionModels())
    expect(Object.isFrozen(shippedSubscriptionModels())).toBe(true)
  })
})

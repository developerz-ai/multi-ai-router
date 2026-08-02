import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { toAccountView } from "../../../src/services/accounts/view"

// The row → admin-view mapping. Most of it is a rename, but two facts carry weight:
// `authMaterial` must collapse to a boolean, and `lastUsedAt` must survive the mapping —
// it was dropped here once, which left the operator with no way to see that the 2.4.0
// stamping fix had landed or that a pooled account was never being selected.

const NOW = new Date("2026-07-24T12:00:00.000Z")

function row(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    label: "claude one",
    provider: "anthropic-oauth",
    status: "active",
    billing: "subscription",
    authMaterial: null,
    configDir: "/data/claude/one",
    tokenExpiresAt: null,
    lastUsedAt: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    weight: 1,
    priority: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe("toAccountView lastUsedAt", () => {
  test("a never-used account maps to null, not to a fake instant", () => {
    expect(toAccountView(row({ lastUsedAt: null })).lastUsedAt).toBeNull()
  })

  test("a stamped account carries the instant through as ISO-8601", () => {
    const used = new Date("2026-07-24T11:59:00.000Z")
    expect(toAccountView(row({ lastUsedAt: used })).lastUsedAt).toBe(used.toISOString())
  })
})

describe("toAccountView credential fact", () => {
  test("auth material collapses to a boolean and never rides along", () => {
    const view = toAccountView(row({ authMaterial: "v1.k1.ciphertext" }))
    expect(view.hasCredential).toBe(true)
    expect(JSON.stringify(view)).not.toContain("ciphertext")
  })
})

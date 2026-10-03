import type { AccountRow } from "@multi-ai-router/db"

/** Full durable fixture; override intent epochs explicitly for lifecycle interleavings. */
export function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  const now = new Date("2026-10-03T00:00:00Z")
  return {
    id: "11111111-1111-4111-8111-111111111111",
    label: "test account",
    provider: "openai-oauth",
    status: "active",
    authMaterial: null,
    configDir: null,
    tokenExpiresAt: null,
    lifecycleVersion: 0,
    healthRecoveryVersion: 0,
    authRecoveryVersion: 0,
    authorizationAttemptId: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    weight: 100,
    priority: 0,
    billing: "subscription",
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

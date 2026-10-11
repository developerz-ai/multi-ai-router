import { describe, expect, test } from "bun:test"
import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import { isWindowSpent } from "../../../src/services/routing/quota"
import { toQuotaEvidence } from "../../../src/services/routing/quota-evidence"
import { memoryAccountQuota } from "../../support/memory-account-quota"
import { NOW } from "../../unit/dataplane/fixtures"

/**
 * Round-trip test for the `advisory` marker on a Codex quota window, against the in-memory
 * repository. A real-DB round-trip lives in
 * `packages/db/test/integration/quota-window-ordering.test.ts`; this one runs without a
 * database and proves the same predicate on the read-back path.
 *
 * The scenario the spec-gate called out: an existing non-advisory row, updated by an advisory
 * reading. The first insert alone would stay green if `advisory` were missing from the conflict
 * set — the second update is what proves the marker survives every step on its way back.
 */

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111"
const FUTURE = new Date(NOW.getTime() + 60 * 60 * 1000)

function accountRow(): AccountRow {
  return {
    id: ACCOUNT_ID,
    lifecycleVersion: 0,
    healthRecoveryVersion: 0,
    authRecoveryVersion: 0,
    authMaterial: null,
    status: "active",
    label: "codex-luna",
    provider: "openai-oauth",
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    billing: "subscription",
    weight: 1,
    priority: 0,
    lastError: null,
    createdAt: NOW,
  } as AccountRow
}

function repo(): AccountRepository {
  const built = memoryAccountQuota([accountRow()], new Map())
  // `memoryAccountQuota` returns a `Pick` with the writer methods the test calls; the rest of
  // the surface is stubbed elsewhere. Narrowing to `AccountRepository` lets the test pass an
  // optional method to a value the test then knows is present.
  return built as unknown as AccountRepository
}

describe("the advisory marker round-trips through the repository and back", () => {
  test("an existing non-advisory row, updated by an advisory reading, still carries the marker", async () => {
    const r = repo()
    // First insert: a non-advisory reading at utilization 1 with a future reset. Without the
    // marker this would block routing — which is what we are about to undo in the next call.
    await r.upsertQuotaWindow(ACCOUNT_ID, {
      window: "five_hour",
      utilization: 1,
      utilizationSource: "continuous",
      resetsAt: FUTURE,
      resetSource: "provider-reported",
      lastCheckedAt: NOW,
    })
    // The advisory reading arrives strictly later. The repository applies it (the conflict-set
    // path); the marker is what differentiates the post-update row from the pre-update one.
    const later = new Date(NOW.getTime() + 1000)
    const written = await r.upsertQuotaWindow(ACCOUNT_ID, {
      window: "five_hour",
      utilization: 1,
      utilizationSource: "continuous",
      resetsAt: FUTURE,
      resetSource: "provider-reported",
      lastCheckedAt: later,
      advisory: true,
    })
    // Round-trip back through the catalog mapper.
    const mapped = toQuotaEvidence({
      ...written,
      retiredAt: null,
      evidenceState: "current",
      blocksRouting: true,
    })
    expect(mapped.advisory).toBe(true)
    // And the routing decision still reflects the marker.
    expect(isWindowSpent(mapped, NOW)).toBe(false)
  })

  test("a window without the marker stays blocking at 100%", async () => {
    const r = repo()
    await r.upsertQuotaWindow(ACCOUNT_ID, {
      window: "seven_day",
      utilization: 1,
      utilizationSource: "continuous",
      resetsAt: FUTURE,
      resetSource: "provider-reported",
      lastCheckedAt: NOW,
    })
    const row = await r.upsertQuotaWindow(ACCOUNT_ID, {
      window: "seven_day",
      utilization: 1,
      utilizationSource: "continuous",
      resetsAt: FUTURE,
      resetSource: "provider-reported",
      lastCheckedAt: NOW,
    })
    const mapped = toQuotaEvidence({
      ...row,
      retiredAt: null,
      evidenceState: "current",
      blocksRouting: true,
    })
    expect(isWindowSpent(mapped, NOW)).toBe(true)
  })
})

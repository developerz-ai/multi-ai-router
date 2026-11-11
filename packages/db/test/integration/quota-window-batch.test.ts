import { describe, expect, test } from "bun:test"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

/**
 * The batched quota writes a flush makes: one transaction for every window of every account,
 * under the same per-row merge rule the single-row upsert applies (that rule is pinned in
 * `quota-window-ordering.test.ts`, which runs through the shared conflict clause too).
 */
const fixture = ownDatabaseFixture("quota_batch")
const at = (second: number) => new Date(Date.UTC(2026, 10, 10, 12, 0, second))
const later = new Date("2090-01-01T00:00:00Z")

function reading(window: "five_hour" | "seven_day", checked: Date, utilization: number) {
  return {
    window,
    utilization,
    utilizationSource: "continuous" as const,
    resetsAt: later,
    resetSource: "provider-reported" as const,
    lastCheckedAt: checked,
  }
}

describe.skipIf(ownDatabaseUrl === "")("upsertQuotaWindows", () => {
  test("writes every window of every account in one call and applies the merge rule", async () => {
    const repo = createAccountRepository(fixture.db())
    const a = await repo.create({ label: "batch-a", provider: "zai" })
    const b = await repo.create({ label: "batch-b", provider: "zai" })
    await repo.upsertQuotaWindow(b.id, reading("five_hour", at(10), 0.9))

    const written = await repo.upsertQuotaWindows([
      { accountId: a.id, state: reading("five_hour", at(1), 0.1) },
      { accountId: a.id, state: reading("seven_day", at(1), 0.2) },
      // Same key twice in one batch, in order: the later reading wins.
      { accountId: a.id, state: reading("five_hour", at(2), 0.3) },
      // Older than what b holds: refused, not counted, held row unchanged.
      { accountId: b.id, state: reading("five_hour", at(5), 0.1) },
      // An account that does not exist is dropped, not a foreign-key failure for the batch.
      { accountId: crypto.randomUUID(), state: reading("five_hour", at(1), 0.5) },
    ])
    expect(written).toBe(3)

    const rows = await repo.listQuotaWindows([a.id, b.id])
    const view = rows.map((row) => [row.accountId, row.window, row.utilization, row.revision])
    expect(view).toEqual(
      [
        [a.id, "five_hour", 0.3, 1],
        [a.id, "seven_day", 0.2, 0],
        [b.id, "five_hour", 0.9, 0],
      ].sort((x, y) => `${x[0]}${x[1]}`.localeCompare(`${y[0]}${y[1]}`)),
    )
    expect(await repo.upsertQuotaWindows([])).toBe(0)
  })

  test("observed batch skips readings whose account moved on, writes the rest", async () => {
    const repo = createAccountRepository(fixture.db())
    const steady = await repo.create({ label: "observed-steady", provider: "zai" })
    const moved = await repo.create({ label: "observed-moved", provider: "zai" })
    const expected = (row: typeof steady) => ({
      lifecycleVersion: row.lifecycleVersion,
      healthRecoveryVersion: row.healthRecoveryVersion,
      authRecoveryVersion: row.authRecoveryVersion,
      authMaterial: row.authMaterial,
      status: row.status,
      recoveryGeneration: null,
    })
    await repo.updateStatus(moved.id, "disabled", at(0))

    const written = await repo.upsertObservedQuotaWindows([
      { accountId: steady.id, state: reading("five_hour", at(1), 0.4), expected: expected(steady) },
      { accountId: moved.id, state: reading("five_hour", at(1), 0.4), expected: expected(moved) },
    ])
    expect(written).toBe(1)
    const rows = await repo.listQuotaWindows([steady.id, moved.id])
    expect(rows.map((row) => row.accountId)).toEqual([steady.id])
  })
})

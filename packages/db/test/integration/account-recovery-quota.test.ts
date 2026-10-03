import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createCatalogSnapshotRepository } from "../../src/repositories/catalog-snapshot-repository"
import { accounts } from "../../src/schema/accounts"
import { reading, recoveryFixture, url } from "./account-recovery-fixture"

const fixture = recoveryFixture()
describe.skipIf(!url)("recovery outcome quota revision fencing", () => {
  test("success supersedes only captured spent evidence and preserves historical values", async () => {
    const account = await fixture.seed()
    const { recovery, quota } = fixture.repositories()
    await quota.upsertQuotaWindow(account.id, reading)
    const issued = await fixture.issue(account)
    const input = {
      ...issued,
      state: "succeeded" as const,
      cooldownMs: 1000,
      quotaSpentThreshold: 1,
    }
    expect(await recovery.outcome({ ...input, expectedEpoch: 0 })).toBeUndefined()
    const completed = await recovery.outcome(input)
    expect(completed?.state).toBe("succeeded")
    const catalog = await createCatalogSnapshotRepository(fixture.db()).read()
    expect(catalog.recoveries.find((row) => row.accountId === account.id)?.state).toBe("succeeded")
    expect(catalog.windows.find((row) => row.accountId === account.id)).toMatchObject({
      evidenceState: "superseded_by_recovery",
      blocksRouting: false,
    })

    const [row] = await fixture.windows(account.id)
    expect(row).toMatchObject({
      utilization: 1,
      evidenceState: "superseded_by_recovery",
      blocksRouting: false,
      revision: 1,
      lastCheckedAt: reading.lastCheckedAt,
    })
    expect(row?.retiredAt).toBeInstanceOf(Date)
    expect(await recovery.outcome(input)).toEqual(completed)
    expect((await fixture.windows(account.id))[0]).toEqual(row)
    expect(await quota.upsertQuotaWindow(account.id, reading)).toEqual(row)
    expect(
      await quota.upsertQuotaWindow(account.id, {
        ...reading,
        lastCheckedAt: new Date("2020-01-02"),
      }),
    ).toMatchObject({ evidenceState: "current", blocksRouting: true, retiredAt: null, revision: 2 })
  })
  test("new provider revision before outcome survives success", async () => {
    const account = await fixture.seed()
    const { recovery, quota } = fixture.repositories()
    await quota.upsertQuotaWindow(account.id, reading)
    const issued = await fixture.issue(account)
    const fresh = await quota.upsertQuotaWindow(account.id, {
      ...reading,
      lastCheckedAt: new Date("2020-01-02"),
    })
    await recovery.outcome({
      ...issued,
      state: "succeeded",
      cooldownMs: 1000,
      quotaSpentThreshold: 1,
    })
    expect((await fixture.windows(account.id))[0]).toEqual(fresh)
  })
  test("floor retirement before outcome survives success", async () => {
    const account = await fixture.seed()
    const { recovery, quota } = fixture.repositories()
    const resetsAt = new Date("2020-01-02")
    const captured = await quota.upsertQuotaWindow(account.id, {
      ...reading,
      resetsAt,
      resetSource: "provider-reported",
    })
    const issued = await fixture.issue(account)
    const expired = await quota.clearObservedQuotaWindow({
      accountId: account.id,
      window: reading.window,
      expected: { revision: captured.revision, resetsAt },
      now: new Date(),
    })
    await recovery.outcome({
      ...issued,
      state: "succeeded",
      cooldownMs: 1000,
      quotaSpentThreshold: 1,
    })
    expect((await fixture.windows(account.id))[0]).toEqual(expired)
    expect(expired?.evidenceState).toBe("expired")
  })
  test("failed and uncertain outcomes preserve quota authority", async () => {
    for (const state of ["failed", "uncertain"] as const) {
      const account = await fixture.seed()
      const { recovery, quota } = fixture.repositories()
      const captured = await quota.upsertQuotaWindow(account.id, reading)
      const issued = await fixture.issue(account)
      await recovery.outcome({ ...issued, state, cooldownMs: 1000, quotaSpentThreshold: 1 })
      expect((await fixture.windows(account.id))[0]).toEqual(captured)
    }
  })
  test("background failure status does not strand issued outcome or lose cooldown", async () => {
    const issued = await fixture.issue()
    await fixture
      .db()
      .update(accounts)
      .set({ status: "cooling_down" })
      .where(eq(accounts.id, issued.accountId))
    const failed = await fixture
      .repositories()
      .recovery.outcome({ ...issued, state: "failed", cooldownMs: 60000, quotaSpentThreshold: 1 })
    expect(failed?.state).toBe("failed")
    expect((failed?.nextAllowedAt.getTime() ?? 0) - (failed?.outcomeAt?.getTime() ?? 0)).toBe(60000)
    expect(await fixture.repositories().accounts.findById(issued.accountId)).toMatchObject({
      status: "cooling_down",
      lifecycleVersion: issued.expected.lifecycleVersion,
    })
  })
  test("success preserves billing/auth restrictions and only retires eligible quota", async () => {
    for (const status of ["needs_reauth", "exhausted", "disabled", "cooling_down"] as const) {
      const account = await fixture.seed()
      const { recovery, quota } = fixture.repositories()
      const original = await quota.upsertQuotaWindow(account.id, reading)
      const issued = await fixture.issue(account)
      await fixture.db().update(accounts).set({ status }).where(eq(accounts.id, account.id))
      expect(
        (
          await recovery.outcome({
            ...issued,
            state: "succeeded",
            cooldownMs: 1000,
            quotaSpentThreshold: 1,
          })
        )?.state,
      ).toBe("succeeded")
      const [held] = await fixture.windows(account.id)
      if (status === "cooling_down")
        expect(held).toMatchObject({
          evidenceState: "superseded_by_recovery",
          blocksRouting: false,
        })
      else expect(held).toEqual(original)
      expect(await fixture.repositories().accounts.findById(account.id)).toMatchObject({
        status,
        lifecycleVersion: issued.expected.lifecycleVersion,
      })
    }
  })
})

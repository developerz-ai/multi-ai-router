import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { accounts } from "../../src/schema/accounts"
import { reading, recoveryFixture, url } from "./account-recovery-fixture"

const fixture = recoveryFixture()
describe.skipIf(!url)("atomic observed status and quota", () => {
  for (const order of ["status-first", "quota-first"] as const) {
    test(`${order} preserves original attempt quota without allowing unrelated status drift`, async () => {
      const account = await fixture.seed()
      const repo = fixture.repositories().accounts
      const expected = { ...account, recoveryGeneration: null }
      if (order === "quota-first")
        await repo.upsertObservedQuotaWindow({ accountId: account.id, expected, state: reading })
      expect(
        await repo.transitionObservedStatus({
          id: account.id,
          expected,
          status: "exhausted",
          quotaWindows: [reading],
          now: new Date(),
        }),
      ).toMatchObject({ status: "exhausted" })
      expect(
        await repo.upsertObservedQuotaWindow({ accountId: account.id, expected, state: reading }),
      ).toBeUndefined()
      expect(await fixture.windows(account.id)).toMatchObject([{ utilization: 1 }])
    })
  }
  test("unrelated blocked status and every recovery epoch reject the entire bundled intent", async () => {
    for (const patch of [
      { status: "exhausted" as const },
      { healthRecoveryVersion: 1 },
      { authRecoveryVersion: 1 },
    ]) {
      const account = await fixture.seed()
      await fixture.db().update(accounts).set(patch).where(eq(accounts.id, account.id))
      expect(
        await fixture.repositories().accounts.transitionObservedStatus({
          id: account.id,
          expected: { ...account, recoveryGeneration: null },
          status: "exhausted",
          quotaWindows: [reading],
          now: new Date(),
        }),
      ).toBeUndefined()
      expect(await fixture.windows(account.id)).toHaveLength(0)
    }
  })
  test("a quota constraint failure rolls back both the status and earlier bundled windows", async () => {
    const account = await fixture.seed()
    const repo = fixture.repositories().accounts
    await expect(
      repo.transitionObservedStatus({
        id: account.id,
        expected: { ...account, recoveryGeneration: null },
        status: "needs_reauth",
        quotaWindows: [
          reading,
          {
            ...reading,
            window: "seven_day",
            utilizationSource: "invalid" as typeof reading.utilizationSource,
          },
        ],
        now: new Date(),
      }),
    ).rejects.toThrow()
    expect(await repo.findById(account.id)).toMatchObject({ status: "active" })
    expect(await fixture.windows(account.id)).toHaveLength(0)
  })
})

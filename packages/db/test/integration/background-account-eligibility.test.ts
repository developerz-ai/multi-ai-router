import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { accounts } from "../../src/schema/accounts"
import { recoveryFixture, url } from "./account-recovery-fixture"

const fixture = recoveryFixture()
describe.skipIf(!url)("durable background account eligibility", () => {
  test("idle enumeration excludes inactive accounts and all open recovery states", async () => {
    const active = await fixture.seed()
    const inactive = await Promise.all(
      ["disabled", "exhausted", "needs_reauth"].map((status) =>
        fixture.seed(status as "disabled" | "exhausted" | "needs_reauth"),
      ),
    )
    const issued = await fixture.issue()
    const pendingAccount = await fixture.seed()
    await fixture.repositories().recovery.beginAutomaticRecovery({
      accountId: pendingAccount.id,
      generationCandidate: crypto.randomUUID(),
      expected: pendingAccount,
      expectedRecoveryRevision: null,
      reason: "quota-stale",
      cooldownMs: 30000,
      maximumOutcomeAgeMs: 600000,
    })
    const uncertain = await fixture.issue()
    await fixture.repositories().recovery.outcome({
      ...uncertain,
      state: "uncertain",
      cooldownMs: 30000,
      quotaSpentThreshold: 1,
    })
    const idle = await fixture
      .repositories()
      .accounts.findIdle({ before: new Date(Date.now() + 1000), limit: 10000 })
    expect(idle.some((row) => row.id === active.id)).toBe(true)
    for (const id of [
      ...inactive.map((row) => row.id),
      issued.accountId,
      pendingAccount.id,
      uncertain.accountId,
    ])
      expect(idle.some((row) => row.id === id)).toBe(false)
    for (const row of inactive)
      expect(
        await fixture.repositories().accounts.readEligibleBackgroundAccount(row.id, row),
      ).toBeUndefined()
    expect(
      await fixture
        .repositories()
        .accounts.readEligibleBackgroundAccount(pendingAccount.id, pendingAccount),
    ).toBeUndefined()
    expect(
      await fixture
        .repositories()
        .accounts.readEligibleBackgroundAccount(issued.accountId, issued.expected),
    ).toBeUndefined()
    expect(
      await fixture
        .repositories()
        .accounts.readEligibleBackgroundAccount(uncertain.accountId, uncertain.expected),
    ).toBeUndefined()
  })
  test("captured identity refuses changes while launch was queued", async () => {
    for (const mutation of ["disable", "recheck", "cipher", "path", "delete"] as const) {
      const original = await fixture.seed()
      const repo = fixture.repositories().accounts
      expect((await repo.readEligibleBackgroundAccount(original.id, original))?.id).toBe(
        original.id,
      )
      if (mutation === "disable")
        await repo.updateOperatorAccount({
          id: original.id,
          patch: { status: "disabled" },
          now: new Date(),
        })
      if (mutation === "recheck") await repo.recheckAccount({ id: original.id, now: new Date() })
      if (mutation === "cipher")
        await repo.saveRefreshedCredential({
          id: original.id,
          expectedAuthMaterial: "cipher",
          authMaterial: "rotated",
          tokenExpiresAt: null,
          now: new Date(),
        })
      if (mutation === "path")
        await repo.update(original.id, { configDir: `/scratch/${original.id}` })
      if (mutation === "delete") await repo.delete(original.id)
      expect(await repo.readEligibleBackgroundAccount(original.id, original)).toBeUndefined()
    }
  })
  test("positive authentication recovery owns the next turn rather than a background warmer", async () => {
    const original = await fixture.seed("needs_reauth")
    const repo = fixture.repositories().accounts
    const confirmed = await repo.recoverObservedAuthentication({
      id: original.id,
      expected: { ...original, status: "needs_reauth" },
      now: new Date(),
    })
    expect(confirmed?.status).toBe("active")
    if (confirmed === undefined) throw new Error("missing auth recovery")
    expect(await repo.readEligibleBackgroundAccount(confirmed.id, confirmed)).toBeUndefined()
    expect(await repo.readEligibleBackgroundAccount(original.id, original)).toBeUndefined()
  })
  test("NULL cipher identity is accepted without treating a replacement or different provider as equivalent", async () => {
    const row = await fixture.seed()
    await fixture.db().update(accounts).set({ authMaterial: null }).where(eq(accounts.id, row.id))
    const repo = fixture.repositories().accounts
    const subject = { ...row, authMaterial: null }
    expect((await repo.readEligibleBackgroundAccount(row.id, subject))?.id).toBe(row.id)
    expect(
      await repo.readEligibleBackgroundAccount(row.id, { ...subject, provider: "openai-api" }),
    ).toBeUndefined()
    await fixture.db().update(accounts).set({ authMaterial: "new" }).where(eq(accounts.id, row.id))
    expect(await repo.readEligibleBackgroundAccount(row.id, subject)).toBeUndefined()
  })
})

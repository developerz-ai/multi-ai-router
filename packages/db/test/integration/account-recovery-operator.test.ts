import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { accountRecoveries } from "../../src/schema/account-recoveries"
import { accounts as accountTable } from "../../src/schema/accounts"
import { recoveryFixture, url } from "./account-recovery-fixture"

const fixture = recoveryFixture()
describe.skipIf(!url)("operator recovery intent and database cooldown", () => {
  test("matching negative CLI report preserves billing and cancels eligibility", async () => {
    const account = await fixture.seed("exhausted")
    const result = await fixture.repositories().recovery.beginOperatorRecovery({
      accountId: account.id,
      generationCandidate: crypto.randomUUID(),
      cooldownMs: 60000,
      negativeAuthObservation: {
        lifecycleVersion: account.lifecycleVersion,
        authMaterial: account.authMaterial,
        loggedIn: false,
      },
    })
    expect(result).toMatchObject({
      rechecked: true,
      clearedStatus: null,
      account: {
        status: "exhausted",
        lifecycleVersion: 1,
        healthRecoveryVersion: 1,
        authRecoveryVersion: 0,
      },
      recovery: { state: "cancelled" },
    })
  })
  test("new operator intent invalidates stale negative CLI observation", async () => {
    const account = await fixture.seed("exhausted")
    const { accounts, recovery } = fixture.repositories()
    await accounts.recheckAccount({ id: account.id, now: new Date() })
    const result = await recovery.beginOperatorRecovery({
      accountId: account.id,
      generationCandidate: crypto.randomUUID(),
      cooldownMs: 60000,
      negativeAuthObservation: {
        lifecycleVersion: account.lifecycleVersion,
        authMaterial: account.authMaterial,
        loggedIn: false,
      },
    })
    expect(result).toMatchObject({
      account: { status: "active", lifecycleVersion: 2, healthRecoveryVersion: 2 },
      recovery: { state: "pending" },
    })
  })
  test("database cooldown rejects replica recheck without advancing account epochs", async () => {
    const account = await fixture.seed()
    const repo = fixture.repositories().recovery
    const first = await repo.beginOperatorRecovery({
      accountId: account.id,
      generationCandidate: crypto.randomUUID(),
      cooldownMs: 60000,
    })
    const second = await repo.beginOperatorRecovery({
      accountId: account.id,
      generationCandidate: crypto.randomUUID(),
      cooldownMs: 1,
    })
    expect(second?.rechecked).toBe(false)
    expect(second?.account).toEqual(first?.account)
    expect(second?.recovery).toEqual(first?.recovery)
  })
  test("disable after issue fences outcome and capability hydration", async () => {
    const issued = await fixture.issue()
    const { accounts, recovery } = fixture.repositories()
    await accounts.disable(issued.accountId, new Date())
    expect(await recovery.hydrateIssued({ ...issued, maximumOutcomeAgeMs: 60000 })).toBeUndefined()
    expect(
      await recovery.outcome({
        ...issued,
        state: "succeeded",
        cooldownMs: 1000,
        quotaSpentThreshold: 1,
      }),
    ).toBeUndefined()
  })
  test("cooldown preflight returns current account without advancing epochs or recovery", async () => {
    const account = await fixture.seed()
    const repo = fixture.repositories().recovery
    expect(await repo.readOperatorCooldown(account.id)).toBeUndefined()
    const begin = await repo.beginOperatorRecovery({
      accountId: account.id,
      generationCandidate: crypto.randomUUID(),
      cooldownMs: 60000,
    })
    await fixture
      .db()
      .update(accountTable)
      .set({ status: "needs_reauth" })
      .where(eq(accountTable.id, account.id))
    const held = await repo.readOperatorCooldown(account.id)
    expect(held).toMatchObject({
      rechecked: false,
      clearedStatus: null,
      account: { status: "needs_reauth", lifecycleVersion: 1, healthRecoveryVersion: 1 },
      recovery: { state: "pending" },
    })
    expect(held?.recovery).toEqual(begin?.recovery)
    await fixture
      .db()
      .update(accountRecoveries)
      .set({ nextAllowedAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(accountRecoveries.accountId, account.id))
    expect(await repo.readOperatorCooldown(account.id)).toBeUndefined()
    await fixture.db().delete(accountTable).where(eq(accountTable.id, account.id))
    expect(await repo.readOperatorCooldown(account.id)).toBeUndefined()
  })
})

import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { accountRecoveries } from "../../src/schema/account-recoveries"
import { recoveryFixture, url } from "./account-recovery-fixture"

const fixture = recoveryFixture()
describe.skipIf(!url)("recovery generation credential and intent invalidation", () => {
  test("stale pending is cancelled regardless caller revision, retaining cooldown before new generation", async () => {
    const account = await fixture.seed()
    const { accounts, recovery } = fixture.repositories()
    const input = {
      accountId: account.id,
      generationCandidate: crypto.randomUUID(),
      expected: account,
      expectedRecoveryRevision: null,
      reason: "quota-stale" as const,
      cooldownMs: 60000,
      maximumOutcomeAgeMs: 600000,
    }
    const pending = await recovery.beginAutomaticRecovery(input)
    await accounts.saveRefreshedCredential({
      id: account.id,
      expectedAuthMaterial: "cipher",
      authMaterial: "rotated",
      tokenExpiresAt: null,
      now: new Date(),
    })
    const current = await accounts.findById(account.id)
    if (current === undefined || pending === undefined)
      throw new Error("missing invalidation fixture")
    expect(await recovery.beginAutomaticRecovery({ ...input, expected: current })).toBeUndefined()
    const [cancelled] = await fixture
      .db()
      .select()
      .from(accountRecoveries)
      .where(eq(accountRecoveries.accountId, account.id))
    expect(cancelled).toMatchObject({
      state: "cancelled",
      generation: pending.generation,
      revision: 1,
      nextAllowedAt: pending.nextAllowedAt,
    })
    expect(
      await recovery.beginAutomaticRecovery({
        ...input,
        generationCandidate: crypto.randomUUID(),
        expected: current,
        expectedRecoveryRevision: 1,
      }),
    ).toBeUndefined()
    await fixture
      .db()
      .update(accountRecoveries)
      .set({ nextAllowedAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(accountRecoveries.accountId, account.id))
    const next = await recovery.beginAutomaticRecovery({
      ...input,
      generationCandidate: crypto.randomUUID(),
      expected: current,
      expectedRecoveryRevision: 1,
    })
    expect(next).toMatchObject({ state: "pending", revision: 2 })
    expect(next?.generation).not.toBe(pending.generation)
  })
  test("stale issued becomes uncertain, held for the outcome bound before another automatic generation", async () => {
    const issued = await fixture.issue()
    const { accounts, recovery } = fixture.repositories()
    await accounts.saveRefreshedCredential({
      id: issued.accountId,
      expectedAuthMaterial: "cipher",
      authMaterial: "new-issued-cipher",
      tokenExpiresAt: null,
      now: new Date(),
    })
    const current = await accounts.findById(issued.accountId)
    if (current === undefined) throw new Error("missing operator fixture")
    const input = {
      accountId: issued.accountId,
      generationCandidate: crypto.randomUUID(),
      expected: current,
      expectedRecoveryRevision: null,
      reason: "cooldown-expired" as const,
      cooldownMs: 1000,
      maximumOutcomeAgeMs: 600000,
    }
    expect(await recovery.beginAutomaticRecovery(input)).toBeUndefined()
    const [uncertain] = await fixture
      .db()
      .select()
      .from(accountRecoveries)
      .where(eq(accountRecoveries.accountId, issued.accountId))
    expect(uncertain).toMatchObject({
      state: "uncertain",
      generation: issued.generation,
      permitId: issued.permitId,
      ownerBootId: issued.ownerBootId,
      revision: 3,
    })
    // The fenced permit may still have a call on the wire: no new start before the outcome bound.
    expect(uncertain?.nextAllowedAt.getTime()).toBeGreaterThanOrEqual(
      (uncertain?.issuedAt?.getTime() ?? 0) + input.maximumOutcomeAgeMs,
    )
    expect(
      await recovery.beginAutomaticRecovery({ ...input, expectedRecoveryRevision: 3 }),
    ).toBeUndefined()
    expect(await recovery.issue(issued)).toBeUndefined()
    await fixture
      .db()
      .update(accountRecoveries)
      .set({ nextAllowedAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(accountRecoveries.accountId, issued.accountId))
    const next = await recovery.beginAutomaticRecovery({
      ...input,
      generationCandidate: crypto.randomUUID(),
      expectedRecoveryRevision: 3,
    })
    expect(next).toMatchObject({ state: "pending", revision: 4 })
    expect(await recovery.issue(issued)).toBeUndefined()
    await fixture
      .db()
      .update(accountRecoveries)
      .set({ nextAllowedAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(accountRecoveries.accountId, issued.accountId))
    expect(
      (
        await recovery.beginOperatorRecovery({
          accountId: issued.accountId,
          generationCandidate: crypto.randomUUID(),
          cooldownMs: 1000,
        })
      )?.recovery.state,
    ).toBe("pending")
  })
})

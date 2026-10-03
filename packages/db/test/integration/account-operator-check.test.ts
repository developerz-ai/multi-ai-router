import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { accountOperatorChecks } from "../../src/schema/account-operator-checks"
import { recoveryFixture, url } from "./account-recovery-fixture"

const fixture = recoveryFixture()
describe.skipIf(!url)("durable operator check exclusion", () => {
  test("two replicas reserve exactly one check before any generation or intent mutation", async () => {
    const account = await fixture.seed()
    const repo = fixture.repositories().recovery
    const results = await Promise.all(
      [1, 2].map(() =>
        repo.reserveOperatorCheck({
          accountId: account.id,
          claimToken: crypto.randomUUID(),
          leaseMs: 30000,
        }),
      ),
    )
    expect(results.map((r) => r?.kind).sort()).toEqual(["acquired", "busy"])
    expect(await fixture.repositories().accounts.findById(account.id)).toEqual(account)
    const acquired = results.find((r) => r?.kind === "acquired")
    if (acquired?.kind !== "acquired") throw new Error("missing claim")
    const finalized = await repo.finalizeOperatorCheck({
      accountId: account.id,
      claimToken: acquired.claimToken,
      generationCandidate: crypto.randomUUID(),
      cooldownMs: 30000,
    })
    expect(finalized?.kind).toBe("committed")
    expect(
      await repo.reserveOperatorCheck({
        accountId: account.id,
        claimToken: crypto.randomUUID(),
        leaseMs: 30000,
      }),
    ).toMatchObject({ kind: "cooldown" })
  })
  test("expired/replaced claim cannot mutate, finalize, or release its successor", async () => {
    const account = await fixture.seed("needs_reauth")
    const repo = fixture.repositories().recovery
    const old = crypto.randomUUID()
    await repo.reserveOperatorCheck({ accountId: account.id, claimToken: old, leaseMs: 30000 })
    await fixture
      .db()
      .update(accountOperatorChecks)
      .set({
        leaseUntil: sql`clock_timestamp() - interval '1 second'`,
      })
      .where(eq(accountOperatorChecks.accountId, account.id))
    expect(
      await fixture.repositories().accounts.recoverObservedAuthentication({
        id: account.id,
        expected: { ...account, status: "needs_reauth", operatorCheckToken: old },
        now: new Date(),
      }),
    ).toBeUndefined()
    expect(
      await repo.finalizeOperatorCheck({
        accountId: account.id,
        claimToken: old,
        generationCandidate: crypto.randomUUID(),
        cooldownMs: 30000,
      }),
    ).toMatchObject({ kind: "refused", checkInProgress: false })
    const next = crypto.randomUUID()
    expect(
      await repo.reserveOperatorCheck({ accountId: account.id, claimToken: next, leaseMs: 30000 }),
    ).toMatchObject({ kind: "acquired" })
    await repo.releaseOperatorCheck({ accountId: account.id, claimToken: old })
    expect(
      await repo.finalizeOperatorCheck({
        accountId: account.id,
        claimToken: old,
        generationCandidate: crypto.randomUUID(),
        cooldownMs: 30000,
      }),
    ).toMatchObject({ kind: "refused", checkInProgress: true })
    expect(
      await fixture.repositories().accounts.transitionObservedStatus({
        id: account.id,
        expected: { ...account, operatorCheckToken: old },
        status: "disabled",
        now: new Date(),
      }),
    ).toBeUndefined()
    expect(
      await fixture.repositories().accounts.recoverObservedAuthentication({
        id: account.id,
        expected: { ...account, status: "needs_reauth", operatorCheckToken: next },
        now: new Date(),
      }),
    ).toMatchObject({ status: "active" })
    const held = await repo.readOperatorCooldown(account.id)
    const finalized = await repo.finalizeOperatorCheck({
      accountId: account.id,
      claimToken: next,
      generationCandidate: crypto.randomUUID(),
      cooldownMs: 30000,
    })
    expect(finalized).toMatchObject({
      kind: "committed",
      result: {
        rechecked: false,
        recovery: { generation: held?.recovery.generation },
        account: { healthRecoveryVersion: account.healthRecoveryVersion },
      },
    })
  })
})

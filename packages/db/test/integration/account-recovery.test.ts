import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { createAccountBreakerRepository } from "../../src/repositories/account-breaker"
import { accountRecoveries } from "../../src/schema/account-recoveries"
import { recoveryFixture, url } from "./account-recovery-fixture"

const fixture = recoveryFixture()
describe.skipIf(!url)("durable recovery ownership and one issuance", () => {
  test("concurrent replicas join one automatic generation", async () => {
    const account = await fixture.seed()
    const repo = fixture.repositories().recovery
    const input = {
      accountId: account.id,
      expected: account,
      expectedRecoveryRevision: null,
      reason: "quota-stale" as const,
      cooldownMs: 1000,
      maximumOutcomeAgeMs: 600000,
    }
    const [first, second] = await Promise.all([
      repo.beginAutomaticRecovery({ ...input, generationCandidate: crypto.randomUUID() }),
      repo.beginAutomaticRecovery({ ...input, generationCandidate: crypto.randomUUID() }),
    ])
    expect(first?.generation).toBe(second?.generation)
    expect(first?.state).toBe("pending")
    const ownerBootId = crypto.randomUUID()
    const ownership = {
      accountId: account.id,
      generation: first?.generation ?? "",
      expectedEpoch: 0,
      ownerBootId,
      leaseMs: 60000,
    }
    expect((await repo.assignPending(ownership))?.ownershipEpoch).toBe(1)
    expect(await repo.assignPending(ownership)).toBeUndefined()
    expect(
      await repo.assignPending({
        ...ownership,
        expectedEpoch: 1,
        ownerBootId: crypto.randomUUID(),
      }),
    ).toBeUndefined()
    expect(await repo.listPending({ limit: 10, accountIds: [] })).toEqual([])
    expect(
      (await repo.listPending({ limit: 10, accountIds: [account.id] })).map((row) => row.accountId),
    ).toEqual([account.id])
  })
  test("issued permits cannot transfer or reissue; same boot can hydrate acknowledgment loss", async () => {
    const input = await fixture.issue()
    const repo = fixture.repositories().recovery
    expect((await repo.issue(input))?.permitId).toBe(input.permitId)
    expect(
      (
        await repo.listIssuedForOwner({
          limit: 1,
          ownerBootId: input.ownerBootId,
          accountIds: [input.accountId],
        })
      ).map((row) => row.accountId),
    ).toEqual([input.accountId])
    expect(
      await repo.listIssuedForOwner({
        limit: 1,
        ownerBootId: crypto.randomUUID(),
        accountIds: [input.accountId],
      }),
    ).toEqual([])
    expect(
      await repo.listIssuedForOwner({ limit: 1, ownerBootId: input.ownerBootId, accountIds: [] }),
    ).toEqual([])

    expect(await repo.issue({ ...input, permitId: crypto.randomUUID() })).toBeUndefined()
    expect(await repo.issue({ ...input, expectedEpoch: 0 })).toBeUndefined()
    expect(
      await repo.assignPending({ ...input, ownerBootId: crypto.randomUUID(), leaseMs: 60000 }),
    ).toBeUndefined()
    expect((await repo.hydrateIssued({ ...input, maximumOutcomeAgeMs: 60000 }))?.state).toBe(
      "issued",
    )
    expect(
      await repo.hydrateIssued({
        ...input,
        ownerBootId: crypto.randomUUID(),
        maximumOutcomeAgeMs: 60000,
      }),
    ).toBeUndefined()
  })
  test("uncertain terminal generation rejects late success and all reissuance", async () => {
    const input = await fixture.issue()
    const repo = fixture.repositories().recovery
    expect(await repo.markUncertain({ ...input, maximumOutcomeAgeMs: 60000 })).toBeUndefined()
    await fixture
      .db()
      .update(accountRecoveries)
      .set({ issuedAt: sql`clock_timestamp() - interval '2 minutes'` })
      .where(eq(accountRecoveries.accountId, input.accountId))
    expect(
      (await repo.listExpiredIssued({ limit: 10, maximumOutcomeAgeMs: 1000 })).some(
        (row) => row.accountId === input.accountId,
      ),
    ).toBe(true)
    expect((await repo.markUncertain({ ...input, maximumOutcomeAgeMs: 1000 }))?.state).toBe(
      "uncertain",
    )
    expect(
      await repo.outcome({
        ...input,
        state: "succeeded",
        cooldownMs: 1000,
        quotaSpentThreshold: 1,
      }),
    ).toBeUndefined()
    expect(await repo.issue(input)).toBeUndefined()
  })
  // Prod 2026-10-04: a designated request settled `uncertain` (the client gave up on it) and the
  // account then refused every request as "settling a recovery probe" until an operator pressed
  // Re-check — `uncertain` was terminal for automatic recovery. It is bounded by its cooldown now.
  test("an uncertain outcome holds through its cooldown, then an automatic generation supersedes it", async () => {
    const input = await fixture.issue()
    const repo = fixture.repositories().recovery
    const settled = await repo.outcome({
      ...input,
      state: "uncertain",
      cooldownMs: 60000,
      quotaSpentThreshold: 1,
    })
    expect(settled?.state).toBe("uncertain")
    const automatic = {
      accountId: input.accountId,
      expected: input.expected,
      expectedRecoveryRevision: settled?.revision ?? null,
      reason: "cooldown-expired" as const,
      cooldownMs: 1000,
      maximumOutcomeAgeMs: 60000,
    }
    expect(
      await repo.beginAutomaticRecovery({ ...automatic, generationCandidate: crypto.randomUUID() }),
    ).toBeUndefined()
    await fixture
      .db()
      .update(accountRecoveries)
      .set({ nextAllowedAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(accountRecoveries.accountId, input.accountId))
    const next = await repo.beginAutomaticRecovery({
      ...automatic,
      generationCandidate: crypto.randomUUID(),
    })
    expect(next).toMatchObject({ state: "pending", ownerBootId: null, permitId: null })
    expect(next?.generation).not.toBe(input.generation)
    // The superseded permit stays fenced: it can neither settle nor reissue the new generation.
    expect(
      await repo.outcome({
        ...input,
        state: "succeeded",
        cooldownMs: 1000,
        quotaSpentThreshold: 1,
      }),
    ).toBeUndefined()
    expect(await repo.issue(input)).toBeUndefined()
  })
  // A probe answered a clean 200, then the account tripped again seconds later. The succeeded row's
  // cooldown gated the next automatic generation, so no permit could be issued for the whole window
  // and the breaker's own short backoff never governed the re-trip.
  test("a succeeded outcome does not make a re-trip wait out the recovery cooldown", async () => {
    const input = await fixture.issue()
    const repo = fixture.repositories().recovery
    const settled = await repo.outcome({
      ...input,
      state: "succeeded",
      cooldownMs: 60000,
      quotaSpentThreshold: 1,
    })
    expect(settled?.state).toBe("succeeded")
    // The column still holds: it is the operator re-check's server-side cooldown.
    expect(settled?.nextAllowedAt.getTime()).toBeGreaterThan(Date.now() + 30000)
    expect(
      (
        await repo.reserveOperatorCheck({
          accountId: input.accountId,
          claimToken: crypto.randomUUID(),
          leaseMs: 1000,
        })
      )?.kind,
    ).toBe("cooldown")
    const automatic = {
      accountId: input.accountId,
      expected: input.expected,
      expectedRecoveryRevision: settled?.revision ?? null,
      reason: "cooldown-expired" as const,
      cooldownMs: 60000,
      maximumOutcomeAgeMs: 60000,
    }
    // The settled generation itself stays single-use.
    expect(
      await repo.beginAutomaticRecovery({ ...automatic, generationCandidate: input.generation }),
    ).toBeUndefined()
    const next = await repo.beginAutomaticRecovery({
      ...automatic,
      generationCandidate: crypto.randomUUID(),
    })
    expect(next).toMatchObject({ state: "pending", ownerBootId: null, permitId: null })
    // The spent permit cannot settle or reissue the new generation.
    expect(await repo.issue(input)).toBeUndefined()
    expect(
      await repo.outcome({ ...input, state: "failed", cooldownMs: 1000, quotaSpentThreshold: 1 }),
    ).toBeUndefined()
  })
  test("after a success, a re-trip waits out the breaker's clock and nothing longer", async () => {
    const input = await fixture.issue()
    const repo = fixture.repositories().recovery
    const settled = await repo.outcome({
      ...input,
      state: "succeeded",
      cooldownMs: 60000,
      quotaSpentThreshold: 1,
    })
    const breakers = createAccountBreakerRepository(fixture.db())
    const tripped = await breakers.observe({
      accountId: input.accountId,
      expected: input.expected,
      observedRevision: 0,
      status: "cooling_down",
      cooldownUntil: new Date(Date.now() + 400),
      cooldownSource: "estimated",
      consecutiveFailures: 1,
    })
    expect(tripped?.status).toBe("cooling_down")
    const begin = () =>
      repo.beginAutomaticRecovery({
        accountId: input.accountId,
        generationCandidate: crypto.randomUUID(),
        expected: input.expected,
        expectedRecoveryRevision: settled?.revision ?? null,
        reason: "cooldown-expired",
        cooldownMs: 60000,
        maximumOutcomeAgeMs: 60000,
      })
    // Inside the breaker's own backoff: no generation.
    expect(await begin()).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 500))
    // Past it, and still 59 s inside the recovery cooldown the succeeded row carries.
    expect(await begin()).toMatchObject({ state: "pending", permitId: null })
  })
  test("a failed outcome still holds the next automatic generation through its cooldown", async () => {
    const input = await fixture.issue()
    const repo = fixture.repositories().recovery
    const settled = await repo.outcome({
      ...input,
      state: "failed",
      cooldownMs: 60000,
      quotaSpentThreshold: 1,
    })
    expect(settled?.state).toBe("failed")
    expect(
      await repo.beginAutomaticRecovery({
        accountId: input.accountId,
        generationCandidate: crypto.randomUUID(),
        expected: input.expected,
        expectedRecoveryRevision: settled?.revision ?? null,
        reason: "cooldown-expired",
        cooldownMs: 60000,
        maximumOutcomeAgeMs: 60000,
      }),
    ).toBeUndefined()
  })
  test("expired pending lease transfers ownership and fences the previous boot", async () => {
    const account = await fixture.seed()
    const repo = fixture.repositories().recovery
    const pending = await repo.beginAutomaticRecovery({
      accountId: account.id,
      generationCandidate: crypto.randomUUID(),
      expected: account,
      expectedRecoveryRevision: null,
      reason: "cooldown-expired",
      cooldownMs: 1000,
      maximumOutcomeAgeMs: 600000,
    })
    if (pending === undefined) throw new Error("missing pending generation")
    const ownerBootId = crypto.randomUUID()
    const ownership = {
      accountId: account.id,
      generation: pending.generation,
      expectedEpoch: 0,
      ownerBootId,
      leaseMs: 60000,
    }
    await repo.assignPending(ownership)
    await fixture
      .db()
      .update(accountRecoveries)
      .set({ preparationLeaseUntil: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(accountRecoveries.accountId, account.id))
    const issue = {
      accountId: account.id,
      generation: pending.generation,
      expectedEpoch: 1,
      ownerBootId,
      permitId: crypto.randomUUID(),
      expected: account,
    }
    expect(await repo.issue(issue)).toBeUndefined()
    const successor = crypto.randomUUID()
    expect(
      await repo.assignPending({ ...ownership, expectedEpoch: 1, ownerBootId: successor }),
    ).toMatchObject({ ownershipEpoch: 2, ownerBootId: successor })
    expect(await repo.issue(issue)).toBeUndefined()
    expect(await repo.issue({ ...issue, expectedEpoch: 2, ownerBootId: successor })).toMatchObject({
      state: "issued",
      ownerBootId: successor,
    })
  })
})

import { describe, expect, test } from "bun:test"
import { recoveryFixture, url } from "./account-recovery-fixture"

const fixture = recoveryFixture()
const COOLDOWN_MS = 30_000
describe.skipIf(!url)("graceful shutdown settles a boot's own recovery permits", () => {
  test("an owned permit becomes uncertain, bounded by the cooldown, and a later boot supersedes it", async () => {
    const input = await fixture.issue()
    const repo = fixture.repositories().recovery
    const settled = await repo.settleIssuedForOwner({
      limit: 10,
      ownerBootId: input.ownerBootId,
      cooldownMs: COOLDOWN_MS,
    })
    const row = settled.find((candidate) => candidate.accountId === input.accountId)
    expect(row?.state).toBe("uncertain")
    expect(row?.permitId).toBe(input.permitId)
    if (row?.outcomeAt === null || row === undefined) throw new Error("missing outcome time")
    expect(row.nextAllowedAt.getTime()).toBe(row.outcomeAt.getTime() + COOLDOWN_MS)
    // Already settled: a repeat touches nothing.
    expect(
      await repo.settleIssuedForOwner({
        limit: 10,
        ownerBootId: input.ownerBootId,
        cooldownMs: COOLDOWN_MS,
      }),
    ).toEqual([])
    // A real verdict arriving late cannot rewrite the settlement into claimed health.
    expect(
      await repo.outcome({
        ...input,
        state: "succeeded",
        cooldownMs: 1,
        quotaSpentThreshold: 1,
      }),
    ).toBeUndefined()

    const begin = {
      accountId: input.accountId,
      expected: input.expected,
      expectedRecoveryRevision: row.revision,
      reason: "cooldown-expired" as const,
      cooldownMs: 1,
      maximumOutcomeAgeMs: 600_000,
    }
    // Inside the cooldown no successor generation opens.
    expect(
      await repo.beginAutomaticRecovery({ ...begin, generationCandidate: crypto.randomUUID() }),
    ).toBeUndefined()
  })
  test("a settled short-cooldown permit is superseded by a pending generation for another boot", async () => {
    const input = await fixture.issue()
    const repo = fixture.repositories().recovery
    const [row] = await repo.settleIssuedForOwner({
      limit: 1,
      ownerBootId: input.ownerBootId,
      cooldownMs: 1,
    })
    if (row === undefined) throw new Error("missing settlement")
    await Bun.sleep(5)
    const next = await repo.beginAutomaticRecovery({
      accountId: input.accountId,
      expected: input.expected,
      expectedRecoveryRevision: row.revision,
      reason: "cooldown-expired",
      generationCandidate: crypto.randomUUID(),
      cooldownMs: COOLDOWN_MS,
      maximumOutcomeAgeMs: 600_000,
    })
    expect(next?.state).toBe("pending")
    expect(next?.ownerBootId).toBeNull()
    expect(next?.generation).not.toBe(input.generation)
  })
  test("another boot's permit and this boot's verdict are left alone", async () => {
    const live = await fixture.issue()
    const repo = fixture.repositories().recovery
    await repo.outcome({
      ...live,
      state: "failed",
      cooldownMs: COOLDOWN_MS,
      quotaSpentThreshold: 1,
    })
    const other = await fixture.issue()
    const settled = await repo.settleIssuedForOwner({
      limit: 10,
      ownerBootId: live.ownerBootId,
      cooldownMs: COOLDOWN_MS,
    })
    expect(settled).toEqual([])
    const recoveries = await repo.listIssuedForOwner({
      limit: 1,
      ownerBootId: other.ownerBootId,
      accountIds: [other.accountId],
    })
    expect(recoveries.map((row) => row.permitId)).toEqual([other.permitId])
  })
})

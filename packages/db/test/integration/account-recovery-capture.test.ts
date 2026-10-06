import { describe, expect, test } from "bun:test"
import { reading, recoveryFixture, url } from "./account-recovery-fixture"

const fixture = recoveryFixture()
const future = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)

async function spentWindows() {
  const account = await fixture.seed()
  const { quota } = fixture.repositories()
  const reported = await quota.upsertQuotaWindow(account.id, {
    ...reading,
    window: "seven_day",
    resetsAt: future(),
    resetSource: "provider-reported",
  })
  const estimated = await quota.upsertQuotaWindow(account.id, {
    ...reading,
    resetsAt: future(),
    resetSource: "estimated",
  })
  const elapsed = await quota.upsertQuotaWindow(account.id, {
    ...reading,
    window: "seven_day_opus",
    resetsAt: new Date("2020-01-02"),
    resetSource: "provider-reported",
  })
  return { account, reported, estimated, elapsed }
}

describe.skipIf(!url)("recovery quota capture", () => {
  test("automatic recovery never captures a provider-reported reset still in the future", async () => {
    const { account, reported, estimated, elapsed } = await spentWindows()
    const recovery = await fixture.repositories().recovery.beginAutomaticRecovery({
      accountId: account.id,
      generationCandidate: crypto.randomUUID(),
      expected: account,
      expectedRecoveryRevision: null,
      reason: "cooldown-expired",
      cooldownMs: 1000,
      maximumOutcomeAgeMs: 600000,
    })
    // Capturing the spent seven_day let each permit spend a certain-429 probe (prod, 2026-10-06).
    expect(recovery?.quotaRevisions).toEqual({
      five_hour: estimated.revision,
      seven_day_opus: elapsed.revision,
    })
    expect(recovery?.quotaRevisions[reported.window]).toBeUndefined()
  })
  test("succeeded automatic probe leaves the uncaptured provider-reported window blocking", async () => {
    const { account } = await spentWindows()
    const issued = await fixture.issue(account)
    await fixture.repositories().recovery.outcome({
      ...issued,
      state: "succeeded",
      cooldownMs: 1000,
      quotaSpentThreshold: 1,
    })
    const windows = await fixture.windows(account.id)
    expect(windows.find((row) => row.window === "seven_day")).toMatchObject({
      evidenceState: "current",
      blocksRouting: true,
      retiredAt: null,
    })
    expect(windows.find((row) => row.window === "five_hour")).toMatchObject({
      evidenceState: "superseded_by_recovery",
    })
  })
  test("operator Re-check may still force a probe through a provider-reported window", async () => {
    const { account, reported, estimated, elapsed } = await spentWindows()
    const begun = await fixture.repositories().recovery.beginOperatorRecovery({
      accountId: account.id,
      generationCandidate: crypto.randomUUID(),
      cooldownMs: 1000,
    })
    expect(begun?.recovery).toMatchObject({ state: "pending", reason: "operator-recheck" })
    expect(begun?.recovery.quotaRevisions).toEqual({
      seven_day: reported.revision,
      five_hour: estimated.revision,
      seven_day_opus: elapsed.revision,
    })
  })
  test("settled reconnect generation does not capture a provider-reported future window", async () => {
    const { account, estimated, elapsed } = await spentWindows()
    await fixture.repositories().accounts.updateOperatorAccount({
      id: account.id,
      patch: { authMaterial: "reconnected" },
      now: new Date(),
    })
    expect(
      await fixture.repositories().recovery.listPending({ limit: 1, accountIds: [account.id] }),
    ).toEqual([])
    const held = await fixture.repositories().recovery.readOperatorCooldown(account.id)
    expect(held?.recovery).toMatchObject({
      state: "cancelled",
      quotaRevisions: { five_hour: estimated.revision, seven_day_opus: elapsed.revision },
    })
  })
})

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createDatabase, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import { createAccountBreakerRepository } from "../../src/repositories/account-breaker"
import { createRecoveryRepository } from "../../src/repositories/account-recovery-repository"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { createCatalogSnapshotRepository } from "../../src/repositories/catalog-snapshot-repository"
import { accountBreakers } from "../../src/schema/account-breakers"
import { accounts } from "../../src/schema/accounts"
import { historyUrl as url, usageHistoryFixture } from "./usage-history-fixture"

const fixture = usageHistoryFixture()
let peer: DatabaseHandle | undefined
beforeAll(() => {
  if (url) peer = createDatabase({ url: fixture.url(), maxConnections: 1 })
})
afterAll(async () => {
  await peer?.close()
})
function peerDb() {
  if (peer === undefined) throw new Error("peer database uninitialized")
  return peer.db
}
const seed = () =>
  createAccountRepository(fixture.db()).create({ provider: "zai", label: "breaker" })
describe.skipIf(!url)("durable account breaker", () => {
  test("fresh and repeated migrations retain an empty catalog", async () => {
    const catalog = createCatalogSnapshotRepository(fixture.db())
    expect((await catalog.read()).breakers).toEqual([])
    await runMigrations({ url: fixture.url(), migrationsFolder: defaultMigrationsFolder() })
    expect((await catalog.read()).breakers).toEqual([])
  })

  test("persisted clocks gate issue, concurrent contenders get one permit, recovery clears only captured evidence", async () => {
    for (const newer of [false, true]) {
      const account = await seed()
      const breakers = createAccountBreakerRepository(fixture.db())
      const recovery = createRecoveryRepository(fixture.db())
      const observation = {
        accountId: account.id,
        expected: account,
        observedRevision: 0,
        status: "cooling_down" as const,
        cooldownUntil: new Date(0),
        cooldownSource: "estimated" as const,
        consecutiveFailures: 1,
      }
      await breakers.observe(observation)
      const begun = await recovery.beginAutomaticRecovery({
        accountId: account.id,
        expected: account,
        expectedRecoveryRevision: null,
        generationCandidate: crypto.randomUUID(),
        reason: "cooldown-expired",
        cooldownMs: 1,
        maximumOutcomeAgeMs: 60000,
      })
      if (begun === undefined) throw new Error("expected recovery generation")
      const ownerBootId = crypto.randomUUID()
      const assigned = await recovery.assignPending({
        accountId: account.id,
        generation: begun.generation,
        expectedEpoch: begun.ownershipEpoch,
        ownerBootId,
        leaseMs: 60000,
      })
      if (assigned === undefined) throw new Error("expected recovery assignment")
      const identity = {
        accountId: account.id,
        expected: account,
        generation: begun.generation,
        ownerBootId,
        expectedEpoch: assigned.ownershipEpoch,
      }
      const future = new Date(Date.now() + 60000)
      const restriction = await breakers.observe({ ...observation, cooldownUntil: future })
      expect(await recovery.issue({ ...identity, permitId: crypto.randomUUID() })).toBeUndefined()
      if (restriction === undefined) throw new Error("expected restriction")
      await breakers.observe({
        ...observation,
        observedRevision: restriction.revision,
        status: "active",
        cooldownUntil: undefined,
        consecutiveFailures: 0,
      })
      await breakers.observe(observation)
      const issued = await Promise.all(
        [recovery, createRecoveryRepository(peerDb())].map((contender) =>
          contender.issue({ ...identity, permitId: crypto.randomUUID() }),
        ),
      )
      expect(issued.filter(Boolean)).toHaveLength(1)
      const permit = issued.find((value) => value !== undefined)
      if (permit?.permitId === null || permit === undefined) throw new Error("expected one permit")
      expect(
        await createRecoveryRepository(peerDb()).issue({ ...identity, permitId: permit.permitId }),
      ).toEqual(permit)
      if (newer) await breakers.observe({ ...observation, cooldownUntil: future })
      await recovery.outcome({
        ...identity,
        permitId: permit.permitId,
        state: "succeeded",
        cooldownMs: 1,
        quotaSpentThreshold: 1,
      })
      const row = (await createCatalogSnapshotRepository(fixture.db()).read()).breakers?.find(
        (value) => value.accountId === account.id,
      )
      expect(row?.status).toBe(newer ? "cooling_down" : "active")
      expect(row?.cooldownUntil).toEqual(newer ? future : null)
    }
  })

  test("durable parked verdicts survive ordinary success and automatic recovery; deletion cascades", async () => {
    for (const status of ["exhausted", "needs_reauth"] as const) {
      const account = await seed()
      const parked = await createAccountBreakerRepository(fixture.db()).observe({
        accountId: account.id,
        expected: account,
        observedRevision: 0,
        status,
        cooldownSource: "unknown",
        consecutiveFailures: 1,
      })
      if (parked === undefined) throw new Error("expected parked breaker")
      expect(
        await createAccountBreakerRepository(peerDb()).observe({
          accountId: account.id,
          expected: account,
          observedRevision: parked.revision,
          status: "active",
          cooldownSource: "unknown",
          consecutiveFailures: 0,
        }),
      ).toBeUndefined()
      expect(
        await createRecoveryRepository(peerDb()).beginAutomaticRecovery({
          accountId: account.id,
          expected: account,
          expectedRecoveryRevision: null,
          generationCandidate: crypto.randomUUID(),
          reason: "cooldown-expired",
          cooldownMs: 1,
          maximumOutcomeAgeMs: 60000,
        }),
      ).toBeUndefined()
      expect(
        (await createCatalogSnapshotRepository(peerDb()).read()).breakers?.find(
          (row) => row.accountId === account.id,
        ),
      ).toEqual(parked)
      await fixture.db().delete(accounts).where(eq(accounts.id, account.id))
      expect(
        await peerDb()
          .select()
          .from(accountBreakers)
          .where(eq(accountBreakers.accountId, account.id)),
      ).toEqual([])
    }
  })

  test("concurrent restrictions merge, stale success cannot erase them, a peer reads the clock", async () => {
    const account = await seed()
    const repository = createAccountBreakerRepository(fixture.db())
    const near = new Date(Date.now() + 60000)
    const far = new Date(near.getTime() + 60000)
    await Promise.all(
      [fixture.db(), peerDb()].map((db, index) =>
        createAccountBreakerRepository(db).observe({
          accountId: account.id,
          expected: account,
          observedRevision: 0,
          status: "cooling_down",
          cooldownUntil: index === 0 ? near : far,
          cooldownSource: index === 0 ? "estimated" : "provider-reported",
          consecutiveFailures: 1,
        }),
      ),
    )
    const held = (await createCatalogSnapshotRepository(peerDb()).read()).breakers?.find(
      (row) => row.accountId === account.id,
    )
    expect(held?.cooldownUntil).toEqual(far)
    expect(held?.cooldownSource).toBe("provider-reported")
    expect(held?.revision).toBe(2)
    expect(
      await repository.observe({
        accountId: account.id,
        expected: account,
        observedRevision: 0,
        status: "active",
        cooldownSource: "unknown",
        consecutiveFailures: 0,
      }),
    ).toBeUndefined()
    expect(
      await createRecoveryRepository(fixture.db()).beginAutomaticRecovery({
        accountId: account.id,
        expected: account,
        expectedRecoveryRevision: null,
        generationCandidate: crypto.randomUUID(),
        reason: "cooldown-expired",
        cooldownMs: 1000,
        maximumOutcomeAgeMs: 60000,
      }),
    ).toBeUndefined()
  })

  test("a probe hold written on one handle is read by the other, a later hold wins, a release clears it", async () => {
    // Probe admission is the half-open gate: one probe per recovering account across the fleet. A hold
    // must survive the writer that took it, be seen through the catalog snapshot, and never be
    // shortened by a rival's earlier deadline.
    const account = await seed()
    const repository = createAccountBreakerRepository(fixture.db())
    const cooling = await repository.observe({
      accountId: account.id,
      expected: account,
      observedRevision: 0,
      status: "cooling_down",
      cooldownUntil: new Date(Date.now() + 60000),
      cooldownSource: "estimated",
      consecutiveFailures: 1,
    })
    if (cooling === undefined) throw new Error("expected cooling breaker")
    const near = new Date(Date.now() + 15000)
    const far = new Date(Date.now() + 30000)
    const taken = await repository.setProbeHold({
      accountId: account.id,
      expected: account,
      probeHeldUntil: near,
    })
    expect(taken?.probeHeldUntil).toEqual(near)
    const seenByPeer = (await createCatalogSnapshotRepository(peerDb()).read()).breakers?.find(
      (row) => row.accountId === account.id,
    )
    expect(seenByPeer?.probeHeldUntil).toEqual(near)
    const later = await createAccountBreakerRepository(peerDb()).setProbeHold({
      accountId: account.id,
      expected: account,
      probeHeldUntil: far,
    })
    expect(later?.probeHeldUntil).toEqual(far)
    expect(
      (
        await repository.setProbeHold({
          accountId: account.id,
          expected: account,
          probeHeldUntil: near,
        })
      )?.probeHeldUntil,
    ).toEqual(far)
    expect(
      (
        await repository.setProbeHold({
          accountId: account.id,
          expected: account,
          probeHeldUntil: null,
        })
      )?.probeHeldUntil,
    ).toBeNull()
    // A superseded generation's hold is dropped, not honoured.
    await fixture
      .db()
      .update(accounts)
      .set({ lifecycleVersion: 1 })
      .where(eq(accounts.id, account.id))
    expect(
      await repository.setProbeHold({
        accountId: account.id,
        expected: account,
        probeHeldUntil: far,
      }),
    ).toBeUndefined()
  })

  test("a probe's own hold never fences its success", async () => {
    const account = await seed()
    const repository = createAccountBreakerRepository(fixture.db())
    const cooling = await repository.observe({
      accountId: account.id,
      expected: account,
      observedRevision: 0,
      status: "cooling_down",
      cooldownUntil: new Date(Date.now() + 60000),
      cooldownSource: "estimated",
      consecutiveFailures: 9,
    })
    if (cooling === undefined) throw new Error("expected cooling breaker")
    const hold = { accountId: account.id, expected: account }
    const taken = await repository.setProbeHold({
      ...hold,
      probeHeldUntil: new Date(Date.now() + 30000),
    })
    expect(taken?.revision).toBe(cooling.revision)
    const released = await repository.setProbeHold({ ...hold, probeHeldUntil: null })
    expect(released?.revision).toBe(cooling.revision)
    const healthy = await repository.observe({
      accountId: account.id,
      expected: account,
      observedRevision: cooling.revision,
      status: "active",
      cooldownSource: "unknown",
      consecutiveFailures: 0,
    })
    expect(healthy).toMatchObject({ status: "active", cooldownUntil: null, consecutiveFailures: 0 })
  })

  test("lifecycle, credential and recovery epochs fence queued observations; parked status stays parked", async () => {
    const account = await seed()
    const repository = createAccountBreakerRepository(fixture.db())
    const input = {
      accountId: account.id,
      expected: account,
      observedRevision: 0,
      status: "cooling_down" as const,
      cooldownUntil: new Date(Date.now() + 60000),
      cooldownSource: "estimated" as const,
      consecutiveFailures: 1,
    }
    for (const patch of [
      { lifecycleVersion: 1 },
      { healthRecoveryVersion: 1 },
      { authRecoveryVersion: 1 },
      { authMaterial: "other-cipher" },
    ]) {
      await fixture.db().update(accounts).set(patch).where(eq(accounts.id, account.id))
      expect(await repository.observe(input)).toBeUndefined()
      await fixture
        .db()
        .update(accounts)
        .set({
          lifecycleVersion: 0,
          healthRecoveryVersion: 0,
          authRecoveryVersion: 0,
          authMaterial: account.authMaterial,
        })
        .where(eq(accounts.id, account.id))
    }
    for (const status of ["exhausted", "needs_reauth", "disabled"] as const) {
      await fixture.db().update(accounts).set({ status }).where(eq(accounts.id, account.id))
      expect(await repository.observe(input)).toBeUndefined()
      expect((await createAccountRepository(fixture.db()).findById(account.id))?.status).toBe(
        status,
      )
    }
  })
})

import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { createDatabase } from "../../src/client"
import { createRecoveryRepository } from "../../src/repositories/account-recovery-repository"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { accounts } from "../../src/schema/accounts"
import { recoveryFixture, url } from "./account-recovery-fixture"

const fixture = recoveryFixture()
describe.skipIf(!url)("observed status recovery generation fence", () => {
  test("explicit absence and old generation reject a newer automatic generation without L/cipher drift", async () => {
    const account = await fixture.seed()
    const { recovery, accounts: repo } = fixture.repositories()
    const pending = await recovery.beginAutomaticRecovery({
      accountId: account.id,
      expected: account,
      expectedRecoveryRevision: null,
      generationCandidate: crypto.randomUUID(),
      reason: "quota-stale",
      cooldownMs: 1000,
    })
    expect(
      await repo.transitionObservedStatus({
        id: account.id,
        expected: { ...account, recoveryGeneration: null },
        status: "exhausted",
        now: new Date(),
      }),
    ).toBeUndefined()
    expect(
      await repo.transitionObservedStatus({
        id: account.id,
        expected: { ...account, recoveryGeneration: crypto.randomUUID() },
        status: "exhausted",
        now: new Date(),
      }),
    ).toBeUndefined()
    expect(
      await repo.transitionObservedStatus({
        id: account.id,
        expected: { ...account, recoveryGeneration: pending?.generation },
        status: "cooling_down",
        now: new Date(),
      }),
    ).toMatchObject({ status: "cooling_down" })
  })
  test("waiting observation rereads generation after automatic begin releases the account lock", async () => {
    const account = await fixture.seed()
    const writer = createDatabase({ url, maxConnections: 1 })
    try {
      const [{ pid }] = await writer.sql<{ pid: number }[]>`select pg_backend_pid() as pid`
      let mutation: Promise<unknown> | undefined
      await fixture.db().transaction(async (tx) => {
        await tx.select().from(accounts).where(eq(accounts.id, account.id)).for("update")
        mutation = createAccountRepository(writer.db).transitionObservedStatus({
          id: account.id,
          expected: { ...account, recoveryGeneration: null },
          status: "exhausted",
          now: new Date(),
        })
        const deadline = Date.now() + 2000
        let waiting = false
        while (Date.now() < deadline) {
          const rows = await fixture
            .db()
            .execute<{ waiting: boolean }>(
              sql`select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = ${pid}`,
            )
          if (rows[0]?.waiting) {
            waiting = true
            break
          }
          await Bun.sleep(1)
        }
        expect(waiting).toBe(true)
        expect(
          (
            await createRecoveryRepository(tx).beginAutomaticRecovery({
              accountId: account.id,
              expected: account,
              expectedRecoveryRevision: null,
              generationCandidate: crypto.randomUUID(),
              reason: "quota-stale",
              cooldownMs: 1000,
            })
          )?.state,
        ).toBe("pending")
      })
      expect(await mutation).toBeUndefined()
      expect(await fixture.repositories().accounts.findById(account.id)).toMatchObject({
        status: "active",
        lifecycleVersion: 0,
        authMaterial: "cipher",
      })
    } finally {
      await writer.close()
    }
  })
})

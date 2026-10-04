import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { createDatabase } from "../../src/client"
import { createRecoveryRepository } from "../../src/repositories/account-recovery-repository"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { accounts } from "../../src/schema/accounts"
import { reading, recoveryFixture, url } from "./account-recovery-fixture"

const fixture = recoveryFixture()
describe.skipIf(!url)("durable quota observation identity", () => {
  test("matching absent-generation observation writes, preserving timestamp and conservative ties", async () => {
    const account = await fixture.seed()
    const repo = fixture.repositories().accounts
    const input = {
      accountId: account.id,
      expected: { ...account, recoveryGeneration: null },
      state: reading,
    }
    const row = await repo.upsertObservedQuotaWindow(input)
    expect(row).toMatchObject({ utilization: 1, revision: 0 })
    const held = await repo.upsertObservedQuotaWindow({
      ...input,
      state: { ...reading, utilization: 0 },
    })
    expect(held).toMatchObject({ utilization: 1, revision: 0 })
    expect(
      await repo.upsertObservedQuotaWindow({
        ...input,
        expected: { ...input.expected, authMaterial: null },
      }),
    ).toBeUndefined()
  })
  test("every durable epoch, cipher and configured status fences a delayed reading", async () => {
    for (const patch of [
      { lifecycleVersion: 1 },
      { healthRecoveryVersion: 1 },
      { authRecoveryVersion: 1 },
      { authMaterial: "rotated" },
      { status: "disabled" as const },
    ]) {
      const account = await fixture.seed()
      await fixture.db().update(accounts).set(patch).where(eq(accounts.id, account.id))
      expect(
        await fixture.repositories().accounts.upsertObservedQuotaWindow({
          accountId: account.id,
          expected: { ...account, recoveryGeneration: null },
          state: reading,
        }),
      ).toBeUndefined()
      expect(await fixture.windows(account.id)).toHaveLength(0)
    }
  })
  test("new automatic generation fences absence without changing L/cipher and accepts its own reading", async () => {
    const account = await fixture.seed()
    const { accounts: repo, recovery } = fixture.repositories()
    const pending = await recovery.beginAutomaticRecovery({
      accountId: account.id,
      expected: account,
      expectedRecoveryRevision: null,
      generationCandidate: crypto.randomUUID(),
      reason: "quota-stale",
      cooldownMs: 1000,
    })
    expect(pending).toBeDefined()
    if (pending === undefined) throw new Error("pending generation missing")
    const input = {
      accountId: account.id,
      expected: { ...account, recoveryGeneration: null as string | null },
      state: reading,
    }
    expect(await repo.upsertObservedQuotaWindow(input)).toBeUndefined()
    expect(
      await repo.upsertObservedQuotaWindow({
        ...input,
        expected: { ...input.expected, recoveryGeneration: pending.generation },
      }),
    ).toBeDefined()
    expect(
      await repo.upsertObservedQuotaWindow({
        ...input,
        expected: { ...input.expected, recoveryGeneration: crypto.randomUUID() },
      }),
    ).toBeUndefined()
  })
  test("a queued writer reads committed generation after waiting for the account lock", async () => {
    const account = await fixture.seed()
    const writer = createDatabase({ url, maxConnections: 1 })
    try {
      const [{ pid }] = await writer.sql<{ pid: number }[]>`select pg_backend_pid() as pid`
      let writing: Promise<unknown> | undefined
      await fixture.db().transaction(async (tx) => {
        await tx.select().from(accounts).where(eq(accounts.id, account.id)).for("update")
        writing = createAccountRepository(writer.db).upsertObservedQuotaWindow({
          accountId: account.id,
          expected: { ...account, recoveryGeneration: null },
          state: reading,
        })
        let waiting = false
        const deadline = Date.now() + 2000
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
        await createRecoveryRepository(tx).beginAutomaticRecovery({
          accountId: account.id,
          expected: account,
          expectedRecoveryRevision: null,
          generationCandidate: crypto.randomUUID(),
          reason: "quota-stale",
          cooldownMs: 1000,
        })
      })
      expect(await writing).toBeUndefined()
      expect(await fixture.windows(account.id)).toHaveLength(0)
    } finally {
      await writer.close()
    }
  })
  test("NULL credential matching is null-safe and deletion is a stale discard", async () => {
    const account = await fixture.seed()
    await fixture
      .db()
      .update(accounts)
      .set({ authMaterial: null })
      .where(eq(accounts.id, account.id))
    const repo = fixture.repositories().accounts
    const input = {
      accountId: account.id,
      expected: { ...account, authMaterial: null, recoveryGeneration: null },
      state: reading,
    }
    expect(await repo.upsertObservedQuotaWindow(input)).toBeDefined()
    await repo.delete(account.id)
    expect(await repo.upsertObservedQuotaWindow(input)).toBeUndefined()
  })
})

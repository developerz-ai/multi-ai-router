import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { createDatabase, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import {
  type AccountRepository,
  createAccountRepository,
} from "../../src/repositories/account-repository"
import { accounts } from "../../src/schema/accounts"

const url = process.env.DATABASE_URL ?? ""
const now = new Date("2026-10-03T00:00:00Z")
let handle: DatabaseHandle | undefined
let repo: AccountRepository
const ids: string[] = []
beforeAll(async () => {
  if (!url) return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  repo = createAccountRepository(handle.db)
})
afterAll(async () => {
  if (handle && ids.length) await handle.db.delete(accounts).where(inArray(accounts.id, ids))
  await handle?.close()
})
function database(): DatabaseHandle {
  if (handle === undefined) throw new Error("database fixture not initialized")
  return handle
}
async function seed(
  status: "active" | "disabled" | "exhausted" | "needs_reauth" = "active",
  authMaterial: string | null = "cipher-r1",
) {
  const row = await repo.create({
    label: "lifecycle-fixture",
    provider: "openai-oauth",
    status,
    authMaterial,
  })
  ids.push(row.id)
  return row
}
describe.skipIf(!url)("account lifecycle atomic observations", () => {
  test("rotated credential saves after disable without undoing operator epochs", async () => {
    const row = await seed()
    const disabled = await repo.disable(row.id, now)
    const saved = await repo.saveRefreshedCredential({
      id: row.id,
      expectedAuthMaterial: "cipher-r1",
      authMaterial: "cipher-r2",
      tokenExpiresAt: now,
      now,
    })
    expect(saved?.status).toBe("disabled")
    expect(saved?.lifecycleVersion).toBe(disabled?.lifecycleVersion)
    expect(saved?.healthRecoveryVersion).toBe(0)
    expect(saved?.authRecoveryVersion).toBe(0)
    expect(
      await repo.transitionObservedStatus({
        id: row.id,
        expected: row,
        status: "needs_reauth",
        now,
      }),
    ).toBeUndefined()
  })
  test("combined operator credential and explicit active intent increments L once/H/A once", async () => {
    const row = await seed("active")
    const edited = await repo.updateOperatorAccount({
      id: row.id,
      patch: { authMaterial: "manual", status: "active" },
      now,
    })
    expect(edited).toMatchObject({
      lifecycleVersion: 1,
      healthRecoveryVersion: 1,
      authRecoveryVersion: 1,
      tokenExpiresAt: null,
    })
    expect(
      await repo.saveRefreshedCredential({
        id: row.id,
        expectedAuthMaterial: "cipher-r1",
        authMaterial: "obsolete",
        tokenExpiresAt: now,
        now,
      }),
    ).toBeUndefined()
  })
  test("recheck returns current authoritative row and preserves disabled/credentials/auth epoch", async () => {
    const row = await seed("exhausted")
    const first = await repo.recheckAccount({ id: row.id, now })
    expect(first).toMatchObject({
      clearedStatus: "exhausted",
      account: {
        status: "active",
        lifecycleVersion: 1,
        healthRecoveryVersion: 1,
        authRecoveryVersion: 0,
        authMaterial: "cipher-r1",
      },
    })
    await repo.disable(row.id, now)
    const second = await repo.recheckAccount({ id: row.id, now })
    expect(second).toMatchObject({
      clearedStatus: null,
      account: { status: "disabled", lifecycleVersion: 3, healthRecoveryVersion: 2 },
    })
  })
  test("NULL credential Claude recovery fences late results and preserves H", async () => {
    const row = await seed("needs_reauth", null)
    const recovered = await repo.recoverObservedAuthentication({
      id: row.id,
      expected: { ...row, status: "needs_reauth" },
      now,
    })
    expect(recovered).toMatchObject({
      status: "active",
      lifecycleVersion: 1,
      authRecoveryVersion: 1,
      healthRecoveryVersion: 0,
    })
    expect(
      await repo.recoverObservedAuthentication({
        id: row.id,
        expected: { ...row, status: "needs_reauth" },
        now,
      }),
    ).toBeUndefined()
  })
  test("successful confirmed authorization preserves disabled and exhaustion", async () => {
    for (const status of ["disabled", "exhausted"] as const) {
      const row = await seed(status, null)
      expect(
        await repo.confirmAccountAuthorization({ id: row.id, expected: row, now }),
      ).toMatchObject({ status, lifecycleVersion: 1, authRecoveryVersion: 1 })
    }
  })
  test("CLI confirmation accepts background status drift and preserves current restrictions", async () => {
    for (const status of ["needs_reauth", "exhausted", "cooling_down", "disabled"] as const) {
      const original = await seed("active", null)
      await database().db.update(accounts).set({ status }).where(eq(accounts.id, original.id))
      const confirmed = await repo.confirmAccountAuthorization({
        id: original.id,
        expected: { lifecycleVersion: original.lifecycleVersion, authMaterial: null },
        now,
      })
      expect(confirmed).toMatchObject({
        status: status === "needs_reauth" ? "active" : status,
        lifecycleVersion: 1,
        authRecoveryVersion: 1,
        healthRecoveryVersion: 0,
        authMaterial: null,
      })
      expect(
        await repo.confirmAccountAuthorization({ id: original.id, expected: original, now }),
      ).toBeUndefined()
    }
  })
  test("CLI confirmation rejects intervening operator intents and credential rotation", async () => {
    for (const mutation of ["disable", "recheck", "credential", "rotation"] as const) {
      const original = await seed()
      if (mutation === "disable") await repo.disable(original.id, now)
      if (mutation === "recheck") await repo.recheckAccount({ id: original.id, now })
      if (mutation === "credential")
        await repo.updateOperatorAccount({
          id: original.id,
          patch: { authMaterial: "manual" },
          now,
        })
      if (mutation === "rotation")
        await repo.saveRefreshedCredential({
          id: original.id,
          expectedAuthMaterial: "cipher-r1",
          authMaterial: "rotated",
          tokenExpiresAt: null,
          now,
        })
      const before = await repo.findById(original.id)
      expect(
        await repo.confirmAccountAuthorization({ id: original.id, expected: original, now }),
      ).toBeUndefined()
      expect(await repo.findById(original.id)).toEqual(before)
    }
  })
  test("observed authentication recovery still rejects background billing status drift", async () => {
    const original = await seed("needs_reauth", null)
    await database()
      .db.update(accounts)
      .set({ status: "exhausted" })
      .where(eq(accounts.id, original.id))
    expect(
      await repo.recoverObservedAuthentication({
        id: original.id,
        expected: { ...original, status: "needs_reauth" },
        now,
      }),
    ).toBeUndefined()
    expect(await repo.findById(original.id)).toMatchObject({
      status: "exhausted",
      lifecycleVersion: 0,
      authRecoveryVersion: 0,
    })
  })
})

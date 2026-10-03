import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { inArray } from "drizzle-orm"
import { createDatabase, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import {
  type AccountRepository,
  createAccountRepository,
} from "../../src/repositories/account-repository"
import { createOauthStateRepository } from "../../src/repositories/oauth-state-repository"
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
async function seed() {
  const row = await repo.create({
    label: "authorization-fixture",
    provider: "openai-oauth",
    status: "needs_reauth",
    authMaterial: "old",
  })
  ids.push(row.id)
  return row
}
function attempt() {
  return {
    id: crypto.randomUUID(),
    state: crypto.randomUUID(),
    codeVerifier: "encrypted-pkce",
    redirectUri: "https://example.invalid/callback",
    expiresAt: new Date(now.getTime() + 60000),
  }
}
async function begin(id: string) {
  return repo.beginAccountAuthorization({
    id,
    expectedProvider: "openai-oauth",
    attempt: attempt(),
    now,
  })
}
describe.skipIf(!url)("durable account authorization identity", () => {
  test("consumed A is fenced by begin B and canceled consumed B", async () => {
    const row = await seed()
    const a = await begin(row.id)
    if (!a || !handle) throw new Error("fixture missing")
    const states = createOauthStateRepository(handle.db)
    expect(await states.consume(a.pending.state, now)).toBeDefined()
    const b = await begin(row.id)
    if (!b) throw new Error("fixture missing")
    expect(
      await repo.commitAuthorization({
        id: row.id,
        expectedLifecycleVersion: a.account.lifecycleVersion,
        attemptId: a.pending.id,
        authMaterial: "a",
        tokenExpiresAt: now,
        now,
      }),
    ).toBeUndefined()
    await states.consume(b.pending.state, now)
    expect(await repo.cancelAccountAuthorization({ id: row.id, now })).toMatchObject({
      cancelled: true,
    })
    expect(
      await repo.commitAuthorization({
        id: row.id,
        expectedLifecycleVersion: b.account.lifecycleVersion,
        attemptId: b.pending.id,
        authMaterial: "b",
        tokenExpiresAt: now,
        now,
      }),
    ).toBeUndefined()
  })
  test("routine refresh during login changes ciphertext without invalidating current attempt", async () => {
    const row = await seed()
    const pending = await begin(row.id)
    if (!pending) throw new Error("fixture missing")
    await repo.saveRefreshedCredential({
      id: row.id,
      expectedAuthMaterial: "old",
      authMaterial: "rotated",
      tokenExpiresAt: now,
      now,
    })
    expect(
      await repo.commitAuthorization({
        id: row.id,
        expectedLifecycleVersion: pending.account.lifecycleVersion,
        attemptId: pending.pending.id,
        authMaterial: "authorized",
        tokenExpiresAt: now,
        now,
      }),
    ).toMatchObject({
      status: "active",
      lifecycleVersion: 1,
      authRecoveryVersion: 1,
      healthRecoveryVersion: 0,
      authorizationAttemptId: null,
      authMaterial: "authorized",
    })
  })
  test("operator disable and recheck each fence a browser callback", async () => {
    for (const mutation of ["disable", "recheck"] as const) {
      const row = await seed()
      const pending = await begin(row.id)
      if (!pending) throw new Error("fixture missing")
      if (mutation === "disable") await repo.disable(row.id, now)
      else await repo.recheckAccount({ id: row.id, now })
      expect(
        await repo.commitAuthorization({
          id: row.id,
          expectedLifecycleVersion: pending.account.lifecycleVersion,
          attemptId: pending.pending.id,
          authMaterial: "late",
          tokenExpiresAt: now,
          now,
        }),
      ).toBeUndefined()
    }
  })
  test("provider mismatch leaves original pending identity untouched", async () => {
    const row = await seed()
    const pending = await begin(row.id)
    expect(
      await repo.beginAccountAuthorization({
        id: row.id,
        expectedProvider: "zai",
        attempt: attempt(),
        now,
      }),
    ).toBeUndefined()
    expect((await repo.findById(row.id))?.authorizationAttemptId).toBe(pending?.pending.id)
  })
  test("legacy account state is rejected while admin OIDC NULL lifecycle remains usable", async () => {
    const row = await seed()
    if (!handle) throw new Error("fixture missing")
    const states = createOauthStateRepository(handle.db)
    const legacy = await states.create({
      ...attempt(),
      provider: "openai-oauth",
      accountId: row.id,
    })
    const admin = await states.create({ ...attempt(), provider: "admin-oidc" })
    expect(await states.consume(legacy.state, now)).toBeUndefined()
    expect(await states.consume(admin.state, now)).toBeDefined()
  })
  test("duplicate state insertion rolls back abandonment and attempt replacement", async () => {
    const row = await seed()
    const original = await begin(row.id)
    if (!original || !handle) throw new Error("fixture missing")
    await expect(
      repo.beginAccountAuthorization({
        id: row.id,
        expectedProvider: "openai-oauth",
        attempt: { ...attempt(), state: original.pending.state },
        now,
      }),
    ).rejects.toBeDefined()
    expect((await repo.findById(row.id))?.authorizationAttemptId).toBe(original.pending.id)
    expect(
      await createOauthStateRepository(handle.db).consume(original.pending.state, now),
    ).toBeDefined()
  })
})

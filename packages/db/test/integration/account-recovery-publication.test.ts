import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { createCatalogSnapshotRepository } from "../../src/repositories/catalog-snapshot-repository"
import { accountRecoveries } from "../../src/schema/account-recoveries"
import { reading, recoveryFixture, url } from "./account-recovery-fixture"

const fixture = recoveryFixture()
const now = new Date()
describe.skipIf(!url)("account recovery intent commits durably with authorization", () => {
  test("CLI confirmation publishes a settled generation, never a probe gate, with configured cooldown and untouched old quota", async () => {
    const original = await fixture.seed("needs_reauth")
    const quota = await fixture.repositories().quota.upsertQuotaWindow(original.id, reading)
    const repo = createAccountRepository(fixture.db(), { recoveryCooldownMs: 12345 })
    const confirmed = await repo.confirmAccountAuthorization({
      id: original.id,
      expected: original,
      now,
    })
    const catalog = await createCatalogSnapshotRepository(fixture.db()).read()
    const recovery = catalog.recoveries.find((row) => row.accountId === original.id)
    // A pending generation gated routing as probe-in-flight right after a verified login.
    expect(recovery).toMatchObject({
      state: "cancelled",
      permitId: null,
      lifecycleVersion: confirmed?.lifecycleVersion,
      reason: "authentication-recovered",
      quotaRevisions: { five_hour: quota.revision },
    })
    expect(recovery?.outcomeAt).toEqual(recovery?.requestedAt ?? null)
    expect((recovery?.nextAllowedAt.getTime() ?? 0) - (recovery?.requestedAt.getTime() ?? 0)).toBe(
      12345,
    )
    expect(catalog.windows.find((row) => row.accountId === original.id)).toEqual(quota)
    expect(
      await repo.confirmAccountAuthorization({ id: original.id, expected: original, now }),
    ).toBeUndefined()
    expect(
      (await createCatalogSnapshotRepository(fixture.db()).read()).recoveries.find(
        (row) => row.accountId === original.id,
      ),
    ).toEqual(recovery)
  })
  test("passive auth recovery, browser commit, credential replacement, and enable each publish one settled generation", async () => {
    for (const intent of ["probe", "browser", "credential", "enable"] as const) {
      const original = await fixture.seed(intent === "probe" ? "needs_reauth" : "active")
      const repo = createAccountRepository(fixture.db())
      const quota = await fixture.repositories().quota.upsertQuotaWindow(original.id, reading)
      if (intent === "probe")
        await repo.recoverObservedAuthentication({
          id: original.id,
          expected: { ...original, status: "needs_reauth" },
          now,
        })
      if (intent === "browser") {
        const attempt = {
          id: crypto.randomUUID(),
          state: crypto.randomUUID(),
          codeVerifier: "encrypted",
          redirectUri: "http://fixture/callback",
          expiresAt: new Date(Date.now() + 60000),
        }
        await repo.beginAccountAuthorization({
          id: original.id,
          expectedProvider: original.provider,
          attempt,
          now,
        })
        await repo.commitAuthorization({
          id: original.id,
          expectedLifecycleVersion: original.lifecycleVersion,
          attemptId: attempt.id,
          authMaterial: "browser-cipher",
          tokenExpiresAt: null,
          now,
        })
      }
      if (intent === "credential")
        await repo.updateOperatorAccount({
          id: original.id,
          patch: { authMaterial: "manual", status: "active" },
          now,
        })
      if (intent === "enable")
        await repo.updateOperatorAccount({ id: original.id, patch: { status: "active" }, now })
      const [recovery] = await fixture
        .db()
        .select()
        .from(accountRecoveries)
        .where(eq(accountRecoveries.accountId, original.id))
      expect(recovery).toMatchObject({
        state: "cancelled",
        revision: 0,
        lifecycleVersion: 1,
        reason: intent === "enable" ? "operator-enable" : "authentication-recovered",
      })
      expect(recovery?.outcomeAt).toBeInstanceOf(Date)
      expect((await fixture.windows(original.id))[0]).toEqual(quota)
    }
  })
  test("reconnect closes an open probe generation instead of leaving the account gated", async () => {
    const account = await fixture.seed()
    const held = await fixture.issue(account)
    const replaced = await fixture.repositories().accounts.updateOperatorAccount({
      id: account.id,
      patch: { authMaterial: "reconnected" },
      now,
    })
    const [recovery] = await fixture
      .db()
      .select()
      .from(accountRecoveries)
      .where(eq(accountRecoveries.accountId, account.id))
    expect(recovery?.generation).not.toBe(held.generation)
    expect(recovery).toMatchObject({
      state: "cancelled",
      permitId: null,
      lifecycleVersion: replaced?.lifecycleVersion,
      reason: "authentication-recovered",
    })
    expect(
      await fixture.repositories().recovery.outcome({
        ...held,
        state: "succeeded",
        cooldownMs: 1000,
        quotaSpentThreshold: 1,
      }),
    ).toBeUndefined()
  })
  test("successful authorization preserves restricted statuses and publishes cancelled eligibility", async () => {
    for (const status of ["disabled", "exhausted"] as const) {
      const original = await fixture.seed(status)
      const confirmed = await fixture
        .repositories()
        .accounts.confirmAccountAuthorization({ id: original.id, expected: original, now })
      expect(confirmed?.status).toBe(status)
      const [recovery] = await fixture
        .db()
        .select()
        .from(accountRecoveries)
        .where(eq(accountRecoveries.accountId, original.id))
      expect(recovery).toMatchObject({ state: "cancelled", lifecycleVersion: 1, permitId: null })
    }
  })
  test("routine refresh and metadata edit never publish recovery", async () => {
    const original = await fixture.seed()
    const repo = fixture.repositories().accounts
    await repo.saveRefreshedCredential({
      id: original.id,
      expectedAuthMaterial: "cipher",
      authMaterial: "refresh",
      tokenExpiresAt: null,
      now,
    })
    await repo.updateOperatorAccount({ id: original.id, patch: { label: "renamed" }, now })
    expect(
      await fixture
        .db()
        .select()
        .from(accountRecoveries)
        .where(eq(accountRecoveries.accountId, original.id)),
    ).toEqual([])
  })
})

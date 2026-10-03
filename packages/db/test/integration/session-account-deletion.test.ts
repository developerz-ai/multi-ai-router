import { afterAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createSessionRepository } from "../../src/repositories/session-repository"
import { apiKeys } from "../../src/schema/api-keys"
import { recoveryFixture, url } from "./account-recovery-fixture"

const f = recoveryFixture()
const keyIds: string[] = []
afterAll(async () => {
  if (!url) return
  for (const id of keyIds) await f.db().delete(apiKeys).where(eq(apiKeys.id, id))
})
describe.skipIf(!url)("session account deletion", () => {
  test("delete clears targeted lineage transactionally and preserves other account bindings", async () => {
    const a = await f.seed(),
      b = await f.seed()
    const [key] = await f
      .db()
      .insert(apiKeys)
      .values({ name: "session-delete", value: "fixture", prefix: "fixture" })
      .returning()
    if (!key) throw new Error("missing fixture key")
    keyIds.push(key.id)
    const repo = createSessionRepository(f.db())
    const input = {
      apiKeyId: key.id,
      lastUsedAt: new Date(),
      lineageState: { prefixHashes: ["hash"], assistantUuids: ["uuid"] },
    }
    await repo.upsert({ ...input, key: "deleted", accountId: a.id, sdkSessionId: "old" })
    await repo.upsert({ ...input, key: "retained", accountId: b.id, sdkSessionId: "other" })
    await f.repositories().accounts.delete(a.id)
    expect((await repo.findByKey(key.id, "deleted"))?.accountId).toBeNull()
    await repo.clearAccount(a.id)
    expect(await repo.findByKey(key.id, "deleted")).toMatchObject({
      accountId: null,
      sdkSessionId: null,
      lineageState: null,
    })
    expect(await repo.findByKey(key.id, "retained")).toMatchObject({
      accountId: b.id,
      sdkSessionId: "other",
    })
    await expect(
      repo.upsert({ ...input, key: "deleted", accountId: a.id, sdkSessionId: "late" }),
    ).rejects.toThrow()
    expect((await repo.findByKey(key.id, "deleted"))?.sdkSessionId).toBeNull()
    // Remove keys here while the shared fixture handle is still open.
    await f.db().delete(apiKeys).where(eq(apiKeys.id, key.id))
    keyIds.splice(keyIds.indexOf(key.id), 1)
  })
})

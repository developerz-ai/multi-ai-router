import { describe, expect, test } from "bun:test"
import { createPendingClaudeLoginRepository } from "../../src/repositories/pending-claude-login-repository"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

const fixture = ownDatabaseFixture("pending_claude_logins")
const inFuture = (ms: number) => new Date(Date.now() + ms)

describe.skipIf(!ownDatabaseUrl)("pending Claude login PostgreSQL fencing", () => {
  test("claim, find and clear round trip", async () => {
    const repo = createPendingClaudeLoginRepository(fixture.db())
    const token = { accountId: crypto.randomUUID(), owner: crypto.randomUUID(), generation: 1n }
    expect(await repo.find(token.accountId)).toBeUndefined()
    expect(await repo.clear(token)).toBe(false)
    expect(await repo.claim(token, inFuture(10_000))).toBe(true)
    const found = await repo.find(token.accountId)
    expect(found).toEqual({
      ...token,
      expiresAt: expect.any(Date),
      updatedAt: expect.any(Date),
    })
    expect(found?.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(await repo.clear(token)).toBe(true)
    expect(await repo.find(token.accountId)).toBeUndefined()
    expect(await repo.clear(token)).toBe(false)
  })

  test("only a newer generation or the same generation supersedes a claim", async () => {
    const repo = createPendingClaudeLoginRepository(fixture.db())
    const accountId = crypto.randomUUID()
    const original = { accountId, owner: crypto.randomUUID(), generation: 5n }
    expect(await repo.claim(original, inFuture(10_000))).toBe(true)
    expect(await repo.claim({ ...original, generation: 4n }, inFuture(10_000))).toBe(false)
    expect(
      await repo.claim(
        { ...original, owner: crypto.randomUUID(), generation: 4n },
        inFuture(10_000),
      ),
    ).toBe(false)
    expect((await repo.find(accountId))?.owner).toBe(original.owner)
    const newer = { ...original, owner: crypto.randomUUID(), generation: 6n }
    expect(await repo.claim(newer, inFuture(10_000))).toBe(true)
    expect((await repo.find(accountId))?.owner).toBe(newer.owner)
    expect((await repo.find(accountId))?.generation).toBe(6n)
    expect(await repo.clear(original)).toBe(false)
    expect(await repo.find(accountId)).toBeDefined()
  })

  test("clear refuses a stale owner or generation", async () => {
    const repo = createPendingClaudeLoginRepository(fixture.db())
    const token = { accountId: crypto.randomUUID(), owner: crypto.randomUUID(), generation: 7n }
    expect(await repo.claim(token, inFuture(10_000))).toBe(true)
    for (const stale of [
      { ...token, owner: crypto.randomUUID() },
      { ...token, generation: token.generation - 1n },
      { ...token, generation: token.generation + 1n },
      { ...token, accountId: crypto.randomUUID() },
    ]) {
      expect(await repo.clear(stale)).toBe(false)
      expect(await repo.find(token.accountId)).toBeDefined()
    }
    expect(await repo.clear(token)).toBe(true)
  })

  test("find treats an expired row as absent and a newer claim revives it", async () => {
    const repo = createPendingClaudeLoginRepository(fixture.db())
    const token = { accountId: crypto.randomUUID(), owner: crypto.randomUUID(), generation: 1n }
    expect(await repo.claim(token, inFuture(10_000))).toBe(true)
    await fixture.sql()`UPDATE account_pending_claude_logins SET expires_at = clock_timestamp() - interval '1 second'
      WHERE account_id = ${token.accountId}::uuid`
    expect(await repo.find(token.accountId)).toBeUndefined()
    const next = { ...token, owner: crypto.randomUUID(), generation: 2n }
    expect(await repo.claim(next, inFuture(10_000))).toBe(true)
    expect((await repo.find(token.accountId))?.owner).toBe(next.owner)
  })

  test("large generations survive as bigint", async () => {
    const repo = createPendingClaudeLoginRepository(fixture.db())
    const token = {
      accountId: crypto.randomUUID(),
      owner: crypto.randomUUID(),
      generation: 9007199254740993n,
    }
    expect(await repo.claim(token, inFuture(10_000))).toBe(true)
    expect((await repo.find(token.accountId))?.generation).toBe(token.generation)
    expect(await repo.clear(token)).toBe(true)
  })
})

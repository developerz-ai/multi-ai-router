import { describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { createApiKeyRepository } from "../../src/repositories/api-key-repository"
import {
  createPriceOverrideRepository,
  PriceOverrideAccountConflict,
} from "../../src/repositories/price-override-repository"
import { accounts } from "../../src/schema/accounts"
import { apiKeys } from "../../src/schema/api-keys"
import { pools } from "../../src/schema/pools"
import { usageContributions } from "../../src/schema/usage-contributions"
import { usageRecords } from "../../src/schema/usage-records"
import {
  historyAttempt,
  historyTerminal,
  historyUrl,
  usageHistoryFixture,
} from "./usage-history-fixture"

const fixture = usageHistoryFixture()
describe.skipIf(!historyUrl)("immutable history subjects and scoped prices", () => {
  test("subject deletion, detail purge and closed-day repair retain historical IDs and one terminal", async () => {
    const account = await createAccountRepository(fixture.db()).create({
      label: "history",
      provider: "zai",
    })
    const key = await createApiKeyRepository(fixture.db()).create({
      name: "history",
      value: "encrypted",
      prefix: "mar_history",
    })
    const [pool] = await fixture.db().insert(pools).values({ name: "history" }).returning()
    if (!pool) throw new Error("pool absent")
    const row = historyAttempt({ accountId: account.id, apiKeyId: key.id, poolId: pool.id })
    const terminal = historyTerminal(row)
    await fixture.usage().insertBatch({ attempts: [row], terminals: [terminal] })
    await fixture.db().delete(accounts).where(eq(accounts.id, account.id))
    await fixture.db().delete(apiKeys).where(eq(apiKeys.id, key.id))
    await fixture.db().delete(pools).where(eq(pools.id, pool.id))
    const [stored] = await fixture.db().select().from(usageRecords)
    expect(stored).toMatchObject({ accountId: account.id, apiKeyId: key.id, poolId: pool.id })
    const before = await fixture.history().totals(fixture.window)
    expect(await fixture.usage().deleteOlderThan(new Date("1984-02-01"), 10)).toBe(2)
    await fixture.history().rollupDay(row.createdAt as Date)
    await fixture.history().rollupDay(terminal.settledAt)
    expect(await fixture.history().totals(fixture.window)).toEqual(before)
    expect((await fixture.history().breakdown(fixture.window, "accountId"))[0]?.id).toBe(account.id)
    expect((await fixture.history().breakdown(fixture.window, "poolId"))[0]?.id).toBe(pool.id)
    expect(await fixture.usage().insertBatch({ attempts: [row], terminals: [terminal] })).toEqual({
      insertedAttempts: 0,
      insertedTerminals: 0,
    })
  })
  test("scoped/global same-model prices coexist; duplicate NULL scope and provider mismatch roll back", async () => {
    const account = await createAccountRepository(fixture.db()).create({
      label: "prices",
      provider: "zai",
    })
    const repo = createPriceOverrideRepository(fixture.db())
    const global = {
      provider: "zai" as const,
      model: "glm",
      inputPerMtok: 1,
      outputPerMtok: 2,
      cacheReadPerMtok: 0,
      cacheWritePerMtok: 0,
    }
    const initial = await repo.replaceAll(
      [global, { ...global, accountId: account.id, inputPerMtok: 3 }],
      new Date(),
    )
    expect(initial).toHaveLength(2)
    await expect(repo.replaceAll([global, global], new Date())).rejects.toMatchObject({
      cause: { code: "23505" },
    })
    expect(await repo.list()).toEqual(initial)
    await expect(
      repo.replaceAll([{ ...global, accountId: account.id, provider: "anthropic" }], new Date()),
    ).rejects.toBeInstanceOf(PriceOverrideAccountConflict)
    expect(await repo.list()).toEqual(initial)
    await fixture.db().delete(accounts).where(eq(accounts.id, account.id))
    expect(await repo.list()).toHaveLength(1)
  })
  test("bounded horizon purge rejects historical replay, while raw below horizon can be removed", async () => {
    let count = 0
    do {
      count = await fixture.history().deleteOlderThan(new Date("1984-02-01"), 1)
      expect(count).toBeLessThanOrEqual(1)
    } while (count)
    expect(await fixture.history().totals(fixture.window)).toMatchObject({
      attempts: 0,
      requests: 0,
    })
    expect(await fixture.db().select().from(usageContributions)).toHaveLength(0)
    await expect(fixture.usage().insertMany([historyAttempt()])).rejects.toThrow(
      "retained history horizon",
    )
    const row = historyAttempt()
    await fixture.db().insert(usageRecords).values(row)
    expect(
      await fixture.db().delete(usageRecords).where(eq(usageRecords.id, row.id)).returning(),
    ).toHaveLength(1)
  })
})

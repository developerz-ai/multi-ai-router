import { describe, expect, test } from "bun:test"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { createExhaustedWatchRepository } from "../../src/repositories/exhausted-watch-repository"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

/**
 * The persisted rule-7 ladder. Two replicas taking turns on `cooldown_recheck`, or one replica
 * restarting, must read back exactly the step the previous tick wrote.
 */
const fixture = ownDatabaseFixture("exhausted_watch")
const at = (hour: number) => new Date(Date.UTC(2026, 10, 10, hour))

describe.skipIf(ownDatabaseUrl === "")("exhausted watch repository", () => {
  test("save, advance, read back from a second handle, remove", async () => {
    const accounts = createAccountRepository(fixture.db())
    const account = await accounts.create({
      label: "drained",
      provider: "zai",
      status: "exhausted",
    })
    const replicaA = createExhaustedWatchRepository(fixture.db())
    const replicaB = createExhaustedWatchRepository(fixture.db())

    expect(await replicaA.list()).toEqual([])
    expect(await replicaA.save(account.id, { retests: 0, dueAt: at(1), lastRetestAt: null })).toBe(
      true,
    )
    expect(await replicaA.save(account.id, { retests: 3, dueAt: at(9), lastRetestAt: at(1) })).toBe(
      true,
    )
    // A fresh process (or the other replica) resumes at the persisted step, not at the first.
    expect(await replicaB.list()).toEqual([
      { accountId: account.id, retests: 3, dueAt: at(9), lastRetestAt: at(1) },
    ])

    expect(await replicaB.remove(account.id)).toBe(true)
    expect(await replicaB.remove(account.id)).toBe(false)
    expect(await replicaA.list()).toEqual([])
  })

  test("a watch for a deleted account is not written and goes with its account", async () => {
    const accounts = createAccountRepository(fixture.db())
    const watches = createExhaustedWatchRepository(fixture.db())
    expect(
      await watches.save(crypto.randomUUID(), { retests: 0, dueAt: at(1), lastRetestAt: null }),
    ).toBe(false)

    const account = await accounts.create({ label: "gone", provider: "zai", status: "exhausted" })
    await watches.save(account.id, { retests: 1, dueAt: at(2), lastRetestAt: at(1) })
    await accounts.delete(account.id)
    expect(await watches.list()).toEqual([])
  })
})

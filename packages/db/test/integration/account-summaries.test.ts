import { describe, expect, test } from "bun:test"
import { createAccountRepository } from "../../src/repositories/account-repository"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

/**
 * The ciphertext-free projection: background sweeps and pool labels read accounts every tick and
 * never touch a credential, so the envelope must not cross the boundary at all — not as a value,
 * not as a key.
 */
const fixture = ownDatabaseFixture("account_summaries")

describe.skipIf(ownDatabaseUrl === "")("listSummaries", () => {
  test("returns identity and status only, oldest first, with the list filters", async () => {
    const accounts = createAccountRepository(fixture.db())
    const first = await accounts.create({ label: "a", provider: "zai", authMaterial: "cipher-a" })
    const second = await accounts.create({
      label: "b",
      provider: "openrouter",
      status: "disabled",
      authMaterial: "cipher-b",
    })

    const all = await accounts.listSummaries()
    expect(all).toEqual([
      {
        id: first.id,
        label: "a",
        provider: "zai",
        status: "active",
        lastUsedAt: null,
        createdAt: first.createdAt,
      },
      {
        id: second.id,
        label: "b",
        provider: "openrouter",
        status: "disabled",
        lastUsedAt: null,
        createdAt: second.createdAt,
      },
    ])
    for (const row of all) {
      expect(Object.keys(row)).not.toContain("authMaterial")
      expect(Object.keys(row)).not.toContain("configDir")
    }
    expect((await accounts.listSummaries({ status: "disabled" })).map((r) => r.id)).toEqual([
      second.id,
    ])
    expect((await accounts.listSummaries({ provider: "zai" })).map((r) => r.id)).toEqual([first.id])
    expect((await accounts.list()).map((r) => r.id)).toEqual([first.id, second.id])
  })
})

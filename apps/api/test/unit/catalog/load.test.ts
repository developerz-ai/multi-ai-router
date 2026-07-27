import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { type CatalogSources, loadCatalog } from "../../../src/services/catalog"

/**
 * What the warm routing catalog reads out of Postgres.
 *
 * This runs at boot, on a timer, and after an admin write — never on a request — so every rule
 * about how a stored NULL becomes a routing input lives here. The one that matters most is that
 * *absent* and *empty* are not the same claim: routing reads an absent `supportedModels` as
 * unknown (therefore passthrough) and a present one as a declaration it will filter on.
 */

const EPOCH = new Date("2026-01-01T00:00:00.000Z")

function row(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    label: "primary",
    provider: "anthropic-api",
    status: "active",
    authMaterial: null,
    configDir: null,
    tokenExpiresAt: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    weight: 100,
    priority: 0,
    billing: "metered",
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  }
}

function sources(rows: readonly AccountRow[]): CatalogSources {
  return {
    accounts: { list: async () => [...rows], listQuotaWindows: async () => [] },
    pools: { list: async () => [], listMembersForPools: async () => [] },
  }
}

describe("loadCatalog and the declared model set", () => {
  test("a stored list reaches routing — the column exists so this can happen at all", async () => {
    const { accounts } = await loadCatalog(sources([row({ supportedModels: ["glm-4.6"] })]))
    expect(accounts[0]?.snapshot.supportedModels).toEqual(["glm-4.6"])
  })

  test("NULL stays absent, so the account keeps serving any model the client names", async () => {
    const { accounts } = await loadCatalog(sources([row()]))
    expect(accounts[0]?.snapshot.supportedModels).toBeUndefined()
    expect("supportedModels" in (accounts[0]?.snapshot ?? {})).toBe(false)
  })

  test("an empty list is dropped rather than carried — it must not read as 'serves nothing'", async () => {
    // A discovery that came back with nothing, or a list an operator emptied, has told the router
    // nothing. Carrying `[]` would take the account out of selection for every model at once.
    const { accounts } = await loadCatalog(sources([row({ supportedModels: [] })]))
    expect(accounts[0]?.snapshot.supportedModels).toBeUndefined()
  })
})

describe("what the catalog carries off the account row", () => {
  test("billing reaches the routable account, or every priced row files under the wrong basis", async () => {
    // The one column pricing reads. Dropped here it fails silently and in the safe-looking
    // direction: an operator marks a coding plan as a subscription, the console agrees, and every
    // usage row still records `metered` — real spend invented out of a flat fee nobody was billed.
    const { accounts } = await loadCatalog(
      sources([row({ provider: "zai", billing: "subscription" })]),
    )
    expect(accounts[0]?.billing).toBe("subscription")
  })

  test("a metered row carries metered, not whatever the last row said", async () => {
    const { accounts } = await loadCatalog(
      sources([
        row({ id: "11111111-1111-4111-8111-111111111111", billing: "subscription" }),
        row({ id: "22222222-2222-4222-8222-222222222222", billing: "metered" }),
      ]),
    )
    expect(accounts.map((account) => account.billing)).toEqual(["subscription", "metered"])
  })
})

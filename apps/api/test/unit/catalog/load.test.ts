import { describe, expect, test } from "bun:test"
import {
  type AccountBreakerRow,
  type AccountRow,
  credentialFingerprint,
  type QuotaWindowRow,
  type RecoveryRow,
} from "@multi-ai-router/db"
import { type CatalogSources, loadCatalog } from "../../../src/services/catalog"
import { resolveModel } from "../../../src/services/routing"
import { accountRow as durableAccountRow } from "../../support/account-row"

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
  return durableAccountRow({
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
  })
}

function sources(rows: readonly AccountRow[]): CatalogSources {
  return {
    read: async () => ({
      accounts: [...rows],
      pools: [],
      members: [],
      windows: [],
      recoveries: [],
    }),
  }
}

describe("loadCatalog and the declared model set", () => {
  test("breaker evidence is optional and fenced by lifecycle, recovery and credential identity", async () => {
    const account = row()
    const breaker: AccountBreakerRow = {
      accountId: account.id,
      revision: 1,
      lifecycleVersion: account.lifecycleVersion,
      healthRecoveryVersion: account.healthRecoveryVersion,
      authRecoveryVersion: account.authRecoveryVersion,
      credentialFingerprint: credentialFingerprint(account.authMaterial),
      status: "cooling_down",
      cooldownUntil: new Date(EPOCH.getTime() + 60000),
      cooldownSource: "estimated",
      cooldownReason: null,
      consecutiveFailures: 1,
      probeHeldUntil: null,
      capturedGeneration: null,
    }
    const load = async (candidate: AccountBreakerRow) =>
      loadCatalog({
        read: async () => ({
          accounts: [account],
          pools: [],
          members: [],
          windows: [],
          recoveries: [],
          breakers: [candidate],
        }),
      })
    expect((await load(breaker)).accounts[0]?.breaker).toEqual(breaker)
    for (const patch of [
      { lifecycleVersion: 1 },
      { healthRecoveryVersion: 1 },
      { authRecoveryVersion: 1 },
      { credentialFingerprint: "stale" },
    ]) {
      expect((await load({ ...breaker, ...patch })).accounts[0]?.breaker).toBeUndefined()
    }
    expect((await loadCatalog(sources([account]))).accounts[0]?.breaker).toBeUndefined()
  })
  test("a probe hold travels with its breaker row and dies with a stale fence", async () => {
    // The hold is the half-open gate other replicas honour. Carried on the breaker row, it must reach
    // the routable account; carried by a superseded generation it must be dropped, not honoured.
    const account = row()
    const hold = new Date(EPOCH.getTime() + 30_000)
    const breaker: AccountBreakerRow = {
      accountId: account.id,
      revision: 1,
      lifecycleVersion: account.lifecycleVersion,
      healthRecoveryVersion: account.healthRecoveryVersion,
      authRecoveryVersion: account.authRecoveryVersion,
      credentialFingerprint: credentialFingerprint(account.authMaterial),
      status: "cooling_down",
      cooldownUntil: new Date(EPOCH.getTime() + 60_000),
      cooldownSource: "estimated",
      cooldownReason: null,
      consecutiveFailures: 1,
      probeHeldUntil: hold,
      capturedGeneration: null,
    }
    const load = async (candidate: AccountBreakerRow) =>
      loadCatalog({
        read: async () => ({
          accounts: [account],
          pools: [],
          members: [],
          windows: [],
          recoveries: [],
          breakers: [candidate],
        }),
      })
    expect((await load(breaker)).accounts[0]?.breaker?.probeHeldUntil).toEqual(hold)
    expect(
      (await load({ ...breaker, credentialFingerprint: "stale" })).accounts[0]?.breaker,
    ).toBeUndefined()
  })
  test("matching breaker rows never replace parked account status", async () => {
    for (const status of ["exhausted", "needs_reauth", "disabled"] as const) {
      const account = row({ status })
      const breaker: AccountBreakerRow = {
        accountId: account.id,
        revision: 2,
        lifecycleVersion: account.lifecycleVersion,
        healthRecoveryVersion: account.healthRecoveryVersion,
        authRecoveryVersion: account.authRecoveryVersion,
        credentialFingerprint: credentialFingerprint(account.authMaterial),
        status: "cooling_down",
        cooldownUntil: new Date(EPOCH.getTime() + 60000),
        cooldownSource: "provider-reported",
        cooldownReason: null,
        consecutiveFailures: 2,
        probeHeldUntil: null,
        capturedGeneration: null,
      }
      const loaded = await loadCatalog({
        read: async () => ({
          accounts: [account],
          pools: [],
          members: [],
          windows: [],
          recoveries: [],
          breakers: [breaker],
        }),
      })
      expect(loaded.accounts[0]?.snapshot.status).toBe(status)
      expect(loaded.accounts[0]?.snapshot.health.cooldownUntil).toBeUndefined()
      expect(loaded.accounts[0]?.breaker).toEqual(breaker)
    }
  })
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

  test("a subscription carries its provider's model family; a passthrough provider carries none", async () => {
    // Without it an undeclared Claude subscription served every name, and `gpt-5.5` on a mixed key
    // landed there (prod, 2026-10-04). `services/routing/model-family.ts`.
    const { accounts } = await loadCatalog(
      sources([
        row({ provider: "anthropic-oauth" }),
        row({ id: "22222222-2222-4222-8222-222222222222", provider: "zai" }),
      ]),
    )
    expect(accounts[0]?.snapshot.modelFamily?.patterns.length).toBeGreaterThan(0)
    expect("modelFamily" in (accounts[1]?.snapshot ?? {})).toBe(false)
  })

  test("an openrouter row carries its routing variants, so `x:floor` is served where `x` is listed", async () => {
    // Prod 2026-11-15: `deepseek/deepseek-v4.1-flash:floor` was refused `model-unsupported` ~2,000
    // times once `supportedModels` held only the base id. The resolver honours the suffix only if
    // this load carries the provider's variants onto the snapshot.
    const { accounts } = await loadCatalog(
      sources([
        row({ provider: "openrouter", supportedModels: ["x"] }),
        row({ id: "22222222-2222-4222-8222-222222222222", provider: "zai" }),
      ]),
    )
    const openrouter = accounts[0]?.snapshot
    expect(openrouter?.routingVariants).toEqual([":floor", ":nitro", ":exacto", ":online"])
    if (openrouter === undefined) return
    expect(resolveModel(openrouter, "x:floor")).toEqual({
      upstreamModel: "x:floor",
      supported: true,
      aliased: false,
    })
    expect("routingVariants" in (accounts[1]?.snapshot ?? {})).toBe(false)
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

test("atomic catalog hydrates private recovery and public-safe routing evidence", async () => {
  const account = row()
  const recovery: RecoveryRow = {
    accountId: account.id,
    generation: crypto.randomUUID(),
    revision: 2,
    lifecycleVersion: account.lifecycleVersion,
    credentialFingerprint: "internal-only",
    state: "issued",
    reason: "operator-recheck",
    ownerBootId: crypto.randomUUID(),
    ownershipEpoch: 1,
    preparationLeaseUntil: null,
    permitId: crypto.randomUUID(),
    issuedAt: EPOCH,
    outcomeAt: null,
    requestedAt: EPOCH,
    nextAllowedAt: EPOCH,
    quotaRevisions: { five_hour: 1 },
  }
  const window: QuotaWindowRow = {
    id: crypto.randomUUID(),
    accountId: account.id,
    window: "five_hour",
    revision: 2,
    evidenceState: "expired",
    blocksRouting: false,
    advisory: false,
    retiredAt: EPOCH,
    utilization: null,
    utilizationSource: "none",
    resetsAt: null,
    resetSource: "unknown",
    lastCheckedAt: EPOCH,
    createdAt: EPOCH,
  }
  const { accounts } = await loadCatalog({
    read: async () => ({
      accounts: [account],
      pools: [],
      members: [],
      windows: [window],
      recoveries: [recovery],
    }),
  })
  expect(accounts[0]?.recovery).toEqual(recovery)
  expect(accounts[0]?.snapshot.recovery).toMatchObject({
    revision: 2,
    generation: recovery.generation,
    state: "issued",
  })
  expect(accounts[0]?.snapshot.recovery).not.toHaveProperty("permitId")
  expect(accounts[0]?.snapshot.recovery).not.toHaveProperty("ownerBootId")
  expect(accounts[0]?.snapshot.recovery).not.toHaveProperty("credentialFingerprint")
  expect(accounts[0]?.snapshot.quotaWindows?.[0]).toMatchObject({
    revision: 2,
    retiredAt: EPOCH,
    evidenceState: "expired",
    blocksRouting: false,
  })
})

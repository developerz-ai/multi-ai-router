import { describe, expect, test } from "bun:test"
import type { AccountRow, ModelCatalogEntry } from "@multi-ai-router/db"
import { isRefreshable, refreshAccountCatalog } from "../../../src/services/models"

/**
 * One account's catalog refresh: what it asks, what it writes, and — most importantly — what it
 * refuses to touch.
 *
 * The line this file guards is the one the whole feature rests on. `accounts.supported_models`
 * gates routing and is deliberately timer-free: the column's own note says a catalog refreshing
 * itself would change routing without an operator asking. This refresh writes `model_catalog`
 * instead, which nothing in selection reads — so an upstream retiring a model changes what the
 * listing *says* and never where a request lands. A test that let this write `supported_models`
 * would be reintroducing exactly the behaviour that decision rejected.
 */

const NOW = new Date("2026-07-28T12:00:00.000Z")

function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "acc-1",
    label: "acc-1",
    provider: "zai",
    status: "active",
    authMaterial: "plaintext-key",
    configDir: null,
    tokenExpiresAt: null,
    lastUsedAt: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    billing: "metered",
    weight: 100,
    priority: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as AccountRow
}

function harness(body: unknown, status = 200) {
  const writes: { accountId: string; rows: readonly ModelCatalogEntry[]; at: Date }[] = []
  let calls = 0

  const deps = {
    catalog: {
      replaceForAccount: async (
        accountId: string,
        rows: readonly ModelCatalogEntry[],
        at: Date,
      ) => {
        writes.push({ accountId, rows, at })
      },
    },
    cipher: { decrypt: (envelope: string) => envelope },
    timeoutMs: 5_000,
    fetch: async () => {
      calls += 1
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
    },
  }

  return { deps, writes, calls: () => calls }
}

describe("refreshing one account's catalog", () => {
  test("writes what the upstream listed, sized from the shipped table where it said nothing", async () => {
    const { deps, writes } = harness({
      data: [{ id: "glm-4.6", object: "model" }, { id: "glm-5.2" }],
    })

    const outcome = await refreshAccountCatalog(deps, accountRow(), NOW)

    expect(outcome).toEqual({ kind: "refreshed", models: 2 })
    expect(writes).toHaveLength(1)
    expect(writes[0]?.rows).toEqual([
      {
        modelId: "glm-4.6",
        contextTokens: 204_800,
        maxOutputTokens: 131_072,
        contextSource: "shipped",
      },
      {
        modelId: "glm-5.2",
        contextTokens: 1_048_576,
        maxOutputTokens: 131_072,
        contextSource: "shipped",
      },
    ])
    expect(writes[0]?.at).toEqual(NOW)
  })

  /**
   * The opposite of the discover button, and deliberately so. There, `[]` would tell *routing* the
   * account serves nothing, which is why it is refused. Here the table only describes, so an
   * upstream that now lists nothing is a fact worth recording rather than one to suppress.
   */
  test("an empty listing is recorded rather than suppressed", async () => {
    const { deps, writes } = harness({ data: [] })

    expect(await refreshAccountCatalog(deps, accountRow(), NOW)).toEqual({
      kind: "refreshed",
      models: 0,
    })
    expect(writes[0]?.rows).toEqual([])
  })

  test("a failed listing leaves the previous catalog alone", async () => {
    const { deps, writes } = harness({ error: { message: "nope" } }, 401)

    const outcome = await refreshAccountCatalog(deps, accountRow(), NOW)

    expect(outcome).toEqual({ kind: "failed", reason: "discovery_failed" })
    // A stale description beats an empty one, and the credential's health is the health path's job.
    expect(writes).toEqual([])
  })

  test("a Claude subscription is skipped without a socket being opened", async () => {
    const { deps, writes, calls } = harness({ data: [] })

    const outcome = await refreshAccountCatalog(
      deps,
      accountRow({ provider: "anthropic-oauth" }),
      NOW,
    )

    expect(outcome).toEqual({ kind: "skipped", reason: "agent-sdk:no-listing" })
    expect(calls()).toBe(0)
    expect(writes).toEqual([])
  })

  test("the aggregator is skipped by name, and says which rule fired", async () => {
    const { deps, calls } = harness({ data: [] })

    expect(await refreshAccountCatalog(deps, accountRow({ provider: "openrouter" }), NOW)).toEqual({
      kind: "skipped",
      reason: "openrouter:aggregator",
    })
    expect(calls()).toBe(0)
  })

  test("the operator's own off switch outranks every other reason", async () => {
    const { deps } = harness({ data: [] })

    // Disabled *and* an aggregator: the reason names the rule that actually fired first.
    expect(
      await refreshAccountCatalog(
        deps,
        accountRow({ provider: "openrouter", status: "disabled" }),
        NOW,
      ),
    ).toEqual({ kind: "skipped", reason: "account:disabled" })
  })
})

describe("which accounts are refreshable at all", () => {
  test("an ordinary HTTP account is", () => {
    expect(isRefreshable({ provider: "zai", status: "active" })).toBe(true)
  })

  test("a blocked credential still has a catalog — only `disabled` is excluded", () => {
    expect(isRefreshable({ provider: "zai", status: "exhausted" })).toBe(true)
    expect(isRefreshable({ provider: "zai", status: "needs_reauth" })).toBe(true)
    expect(isRefreshable({ provider: "zai", status: "cooling_down" })).toBe(true)
    expect(isRefreshable({ provider: "zai", status: "disabled" })).toBe(false)
  })

  test("the three exclusions", () => {
    expect(isRefreshable({ provider: "openrouter", status: "active" })).toBe(false)
    expect(isRefreshable({ provider: "anthropic-oauth", status: "active" })).toBe(false)
    expect(isRefreshable({ provider: "zai", status: "disabled" })).toBe(false)
  })
})

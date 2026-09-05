import { describe, expect, test } from "bun:test"
import type { AccountView, PoolView } from "../../src/lib/api/types"
import { reachableAccountIds, scopeReaches } from "../../src/lib/key-scope"

function account(id: string, provider: AccountView["provider"]): AccountView {
  return {
    id,
    label: id,
    provider,
    status: "active",
    hasCredential: true,
    configDir: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    weight: 100,
    priority: 0,
    billing: "metered",
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  }
}

const accounts = [account("sub", "anthropic-oauth"), account("zai", "zai")]
const pools: PoolView[] = [
  {
    id: "p-claude",
    name: "claude-subs",
    policy: "priority-failover",
    overflowAccountId: null,
    members: [
      {
        accountId: "sub",
        label: "sub",
        provider: "anthropic-oauth",
        status: "active",
        weight: 100,
        priority: 1,
      },
    ],
    createdAt: "",
    updatedAt: "",
  },
  {
    id: "p-cn",
    name: "cn",
    policy: "round-robin",
    overflowAccountId: null,
    members: [
      {
        accountId: "zai",
        label: "zai",
        provider: "zai",
        status: "active",
        weight: 100,
        priority: 0,
      },
    ],
    createdAt: "",
    updatedAt: "",
  },
]
const isSub = (a: AccountView) => a.provider === "anthropic-oauth"

describe("key scope reach", () => {
  test("all reaches everything", () => {
    expect([
      ...reachableAccountIds({ kind: "all", poolIds: [], accountIds: [] }, pools, accounts),
    ]).toEqual(["sub", "zai"])
  })

  test("a pool scope reaches exactly its members — intersection, never wider", () => {
    expect(
      scopeReaches({ kind: "pools", poolIds: ["p-cn"], accountIds: [] }, pools, accounts, isSub),
    ).toBe(false)
    expect(
      scopeReaches(
        { kind: "pools", poolIds: ["p-claude"], accountIds: [] },
        pools,
        accounts,
        isSub,
      ),
    ).toBe(true)
  })

  test("an explicit account scope reaches only the named ids", () => {
    expect(
      scopeReaches({ kind: "accounts", poolIds: [], accountIds: ["zai"] }, pools, accounts, isSub),
    ).toBe(false)
    expect(
      scopeReaches({ kind: "accounts", poolIds: [], accountIds: ["sub"] }, pools, accounts, isSub),
    ).toBe(true)
  })
})

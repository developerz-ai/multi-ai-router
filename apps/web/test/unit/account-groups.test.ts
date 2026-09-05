import { describe, expect, test } from "bun:test"
import { groupAccountsByProvider, poolNamesFor } from "../../src/lib/account-groups"
import type { AccountView, PoolView } from "../../src/lib/api/types"

const NOW = Date.parse("2026-09-05T12:00:00.000Z")
const DAY = 86_400_000

function account(overrides: Partial<AccountView>): AccountView {
  return {
    id: overrides.label ?? "acc",
    label: "acc",
    provider: "zai",
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
    ...overrides,
  }
}

describe("groupAccountsByProvider", () => {
  test("problems first, then the bigger fleet, then name", () => {
    const groups = groupAccountsByProvider(
      [
        account({ label: "z1", provider: "zai" }),
        account({ label: "k1", provider: "kimi" }),
        account({ label: "k2", provider: "kimi" }),
        account({ label: "m1", provider: "minimax", status: "exhausted" }),
      ],
      NOW,
    )
    expect(groups.map((group) => group.provider)).toEqual(["minimax", "kimi", "zai"])
    expect(groups[0]?.attention).toBe(1)
    expect(groups[0]?.worst).toBe("exhausted")
  })

  test("counts routable now, not merely active — a spent window is not capacity", () => {
    const [group] = groupAccountsByProvider(
      [
        account({ label: "a" }),
        account({
          label: "b",
          availability: {
            configuredStatus: "active",
            resetsAt: null,
            resetSource: "unknown",
            lastCheckedAt: null,
            consecutiveFailures: 0,
            inFlight: 0,
            quotaWindows: [
              {
                window: "five_hour",
                utilization: 1,
                utilizationSource: "gauge",
                resetsAt: null,
                resetSource: "unknown",
                lastCheckedAt: "2026-09-05T11:00:00.000Z",
                spent: true,
                tokensUsed: null,
                tokenLimit: null,
              },
            ],
          },
        }),
      ],
      NOW,
    )
    expect(group?.routable).toBe(1)
    expect(group?.accounts.length).toBe(2)
  })

  test("subscriptions: soonest valid login expiry, and the expired ones form the reconnect queue", () => {
    const cred = (expiresAt: string | null, present = true) => ({
      expiresAt,
      subscriptionType: "max",
      rateLimitTier: null,
      present,
    })
    const [group] = groupAccountsByProvider(
      [
        account({
          label: "s1",
          provider: "anthropic-oauth",
          priority: 3,
          credential: cred(new Date(NOW + 9 * DAY).toISOString()),
        }),
        account({
          label: "s2",
          provider: "anthropic-oauth",
          priority: 1,
          credential: cred(new Date(NOW + 4 * DAY).toISOString()),
        }),
        account({
          label: "s3",
          provider: "anthropic-oauth",
          priority: 2,
          status: "needs_reauth",
          credential: cred(null, false),
        }),
        account({
          label: "s4",
          provider: "anthropic-oauth",
          priority: 4,
          credential: cred(new Date(NOW + 20 * DAY).toISOString(), false),
        }),
      ],
      NOW,
    )
    expect(group?.nextLoginExpiryMs).toBe(NOW + 4 * DAY)
    expect(group?.reconnectable.map((a) => a.label)).toEqual(["s3", "s4"])
    // s3 is counted once, s4 (tokens gone, status still active) adds one.
    expect(group?.attention).toBe(2)
    expect(group?.worst).toBe("needs_reauth")
    // Rows in priority order — how a priority-failover pool reads them.
    expect(group?.accounts.map((a) => a.label)).toEqual(["s2", "s3", "s1", "s4"])
  })

  test("a group of only disabled accounts reads disabled, not active", () => {
    const [group] = groupAccountsByProvider([account({ label: "off", status: "disabled" })], NOW)
    expect(group?.worst).toBe("disabled")
    expect(group?.attention).toBe(0)
  })

  test("an unknown provider id still gets a group, named by its id", () => {
    const [group] = groupAccountsByProvider(
      [account({ label: "x", provider: "brand-new" as AccountView["provider"] })],
      NOW,
    )
    expect(group?.name).toBe("brand-new")
  })
})

describe("poolNamesFor", () => {
  test("names every pool holding any of the accounts, in pool order", () => {
    const pool = (id: string, name: string, ids: readonly string[]): PoolView => ({
      id,
      name,
      policy: "round-robin",
      overflowAccountId: null,
      members: ids.map((accountId) => ({
        accountId,
        label: accountId,
        provider: "zai",
        status: "active",
        weight: 100,
        priority: 0,
      })),
      createdAt: "",
      updatedAt: "",
    })
    const pools = [
      pool("p1", "claude-subs", ["s1", "s2"]),
      pool("p2", "cn", ["z1"]),
      pool("p3", "mixed", ["z1", "s2"]),
    ]
    expect(poolNamesFor(pools, [{ id: "s2" }])).toEqual(["claude-subs", "mixed"])
    expect(poolNamesFor(pools, [{ id: "nobody" }])).toEqual([])
  })
})

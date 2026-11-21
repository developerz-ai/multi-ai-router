import { describe, expect, test } from "bun:test"
import type { VerifiedKey } from "../../../src/services/dataplane"
import { countProviders, providerListing } from "../../../src/services/dataplane"
import { coolingOf } from "../../../src/services/dataplane/provider-listing"
import { account, catalog, health, NOW } from "./fixtures"

/**
 * `GET /v1/providers` — which upstreams a key can reach and how deep each pool is.
 *
 * `accounts` counts every in-scope credential whatever its status, so it is not liveness: a reader
 * sizing capacity from it counts an `exhausted` account as capacity. The per-status counts are the
 * answer to that, and they must come from the **live** status — the health-overlaid one routing
 * reads — or an account the breaker cooled a minute ago is still counted `active`.
 */

const ZERO = { active: 0, disabled: 0, cooling_down: 0, exhausted: 0, needs_reauth: 0 }

function fullScope(): VerifiedKey {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "test-key",
    prefix: "mar_live_test",
    scope: { kind: "all" },
    rateLimitRequests: null,
    rateLimitWindowSeconds: null,
    expiresAt: null,
  }
}

function scopedTo(accountIds: readonly string[]): VerifiedKey {
  return { ...fullScope(), scope: { kind: "accounts", accountIds: [...accountIds] } }
}

describe("countProviders", () => {
  test("splits each provider's accounts by status, every status present, summing to accounts", () => {
    const rows = countProviders([
      { provider: "zai", status: "active" },
      { provider: "zai", status: "cooling_down" },
      { provider: "zai", status: "exhausted" },
      { provider: "zai", status: "needs_reauth" },
      { provider: "zai", status: "disabled" },
      { provider: "minimax", status: "active" },
    ])

    expect(rows).toEqual([
      { id: "minimax", accounts: 1, available: 1, statuses: { ...ZERO, active: 1 }, cooling: [] },
      {
        id: "zai",
        accounts: 5,
        // `available` keeps its meaning: a cooldown is a clock, so it still counts.
        available: 2,
        statuses: { active: 1, disabled: 1, cooling_down: 1, exhausted: 1, needs_reauth: 1 },
        cooling: [],
      },
    ])
    for (const row of rows) {
      const sum = Object.values(row.statuses).reduce((total, count) => total + count, 0)
      expect(sum).toBe(row.accounts)
    }
  })

  test("no accounts is no rows, never a provider with zeros", () => {
    expect(countProviders([])).toEqual([])
  })
})

describe("the provider listing", () => {
  test("counts in-scope accounts and how many of them could serve right now", () => {
    const list = providerListing(
      {
        catalog: catalog([
          account("live", { provider: "zai" }),
          account("spent", { provider: "zai", snapshot: { status: "exhausted" } }),
          account("other", { provider: "minimax" }),
        ]),
        health: health(),
      },
      fullScope(),
      NOW,
    )

    expect(list).toEqual([
      { id: "minimax", accounts: 1, available: 1, statuses: { ...ZERO, active: 1 }, cooling: [] },
      // The state worth seeing: two credentials exist, one can be used.
      {
        id: "zai",
        accounts: 2,
        available: 1,
        statuses: { ...ZERO, active: 1, exhausted: 1 },
        cooling: [],
      },
    ])
  })

  test("status is the live one: a breaker cooldown or a 402 counts, not the stored active", () => {
    const store = health()
    store.recordFailure(
      "cooled",
      {
        kind: "rate-limited",
        resetsAt: new Date(NOW.getTime() + 60_000),
        resetSource: "provider-reported",
        message: "429",
      },
      NOW,
    )
    store.recordFailure("broke", { kind: "credits-exhausted", message: "402" }, NOW)

    const list = providerListing(
      {
        catalog: catalog([
          account("live", { provider: "zai" }),
          account("cooled", { provider: "zai" }),
          account("broke", { provider: "zai" }),
        ]),
        health: store,
      },
      fullScope(),
      NOW,
    )

    expect(list).toEqual([
      {
        id: "zai",
        accounts: 3,
        available: 2,
        statuses: { ...ZERO, active: 1, cooling_down: 1, exhausted: 1 },
        cooling: [
          {
            until: new Date(NOW.getTime() + 60_000),
            reason: "cooling-down",
            resetSource: "provider-reported",
          },
        ],
      },
    ])
  })

  test("a provider with no in-scope account is absent, not present with a zero", () => {
    const list = providerListing(
      {
        catalog: catalog([
          account("mine", { provider: "zai" }),
          account("theirs", { provider: "minimax" }),
        ]),
        health: health(),
      },
      scopedTo(["mine"]),
      NOW,
    )

    // Absent means "never configured for this key"; `available: 0` would mean "configured and
    // unusable", which is a different thing to tell an operator.
    expect(list.map((entry) => entry.id)).toEqual(["zai"])
  })
})

describe("the provider listing names what the router holds and until when", () => {
  // Prod 2026-11-20: a ChatGPT account sat in `cooling_down` for hours on a weekly window, and the
  // platform holding a router key saw only `cooling_down: 1` — no instant, no reason. A key-holder
  // can now say "the router holds this account until T", for its own scope only.
  const WEEK_END = new Date(NOW.getTime() + 6 * 86_400_000)

  test("a breaker cooldown is listed with its instant, reason and provenance", () => {
    const store = health()
    store.recordFailure(
      "cooled",
      {
        kind: "rate-limited",
        resetsAt: WEEK_END,
        resetSource: "provider-reported",
        message: "429",
      },
      NOW,
    )
    const [row] = providerListing(
      {
        catalog: catalog([
          account("live", { provider: "openai-oauth" }),
          account("cooled", { provider: "openai-oauth" }),
        ]),
        health: store,
      },
      fullScope(),
      NOW,
    )
    expect(row?.cooling).toEqual([
      { until: WEEK_END, reason: "cooling-down", resetSource: "provider-reported" },
    ])
  })

  test("a spent quota window is listed with the window's reset", () => {
    const [row] = providerListing(
      {
        catalog: catalog([
          account("spent", {
            provider: "openai-oauth",
            snapshot: {
              quotaWindows: [
                {
                  window: "seven_day",
                  utilization: 1,
                  utilizationSource: "continuous",
                  resetsAt: WEEK_END,
                  resetSource: "provider-reported",
                  lastCheckedAt: NOW,
                },
              ],
            },
          }),
        ]),
        health: health(),
      },
      fullScope(),
      NOW,
    )
    expect(row?.cooling).toEqual([
      {
        until: WEEK_END,
        reason: "quota-window-spent",
        window: "seven_day",
        resetSource: "provider-reported",
      },
    ])
  })

  test("an expired cooldown is a half-open probe, not a hold, so it is not listed", () => {
    const passed = new Date(NOW.getTime() - 1_000)
    const snapshot = {
      ...account("half-open", { provider: "openai-oauth" }).snapshot,
      status: "cooling_down" as const,
      health: { consecutiveFailures: 1, inFlight: 0, recentTokens: 0, cooldownUntil: passed },
    }
    expect(coolingOf(snapshot, NOW)).toBeUndefined()
  })

  test("a cooling account with no stated instant is held with until null", () => {
    const snapshot = {
      ...account("no-instant", { provider: "openai-oauth" }).snapshot,
      status: "cooling_down" as const,
      health: { consecutiveFailures: 1, inFlight: 0, recentTokens: 0 },
    }
    expect(coolingOf(snapshot, NOW)).toEqual({
      until: null,
      reason: "cooling-down",
      resetSource: null,
    })
  })

  test("an account outside the key's scope is never listed", () => {
    const store = health()
    store.recordFailure(
      "theirs",
      {
        kind: "rate-limited",
        resetsAt: WEEK_END,
        resetSource: "provider-reported",
        message: "429",
      },
      NOW,
    )
    const list = providerListing(
      {
        catalog: catalog([
          account("mine", { provider: "openai-oauth" }),
          account("theirs", { provider: "openai-oauth" }),
        ]),
        health: store,
      },
      scopedTo(["mine"]),
      NOW,
    )
    expect(list[0]?.cooling).toEqual([])
  })
})

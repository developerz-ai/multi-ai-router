import { describe, expect, test } from "bun:test"
import type { VerifiedKey } from "../../../src/services/dataplane"
import { countProviders, providerListing } from "../../../src/services/dataplane"
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
      { id: "minimax", accounts: 1, available: 1, statuses: { ...ZERO, active: 1 } },
      {
        id: "zai",
        accounts: 5,
        // `available` keeps its meaning: a cooldown is a clock, so it still counts.
        available: 2,
        statuses: { active: 1, disabled: 1, cooling_down: 1, exhausted: 1, needs_reauth: 1 },
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
      { id: "minimax", accounts: 1, available: 1, statuses: { ...ZERO, active: 1 } },
      // The state worth seeing: two credentials exist, one can be used.
      { id: "zai", accounts: 2, available: 1, statuses: { ...ZERO, active: 1, exhausted: 1 } },
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

import { describe, expect, test } from "bun:test"
import type { AccountCatalogAge, AccountRow } from "@multi-ai-router/db"
import { selectForRefresh } from "../../../src/services/models"

/**
 * Which accounts an hourly tick actually refreshes.
 *
 * This file exists because the obvious implementation — take the first N accounts — is quietly
 * broken in a way no log line reveals: the sweep runs, the tally is full, and account N+1's
 * catalog is however old it was on the day it was added. Two properties fix that, and both are
 * asserted here rather than assumed: order by staleness, and drop what can never be refreshed
 * *before* applying the cap.
 */

const AT = (iso: string): Date => new Date(iso)

function account(id: string, overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id,
    label: id,
    provider: "zai",
    status: "active",
    ...overrides,
  } as AccountRow
}

function age(accountId: string, iso: string): AccountCatalogAge {
  return { accountId, refreshedAt: AT(iso) }
}

describe("choosing the accounts one catalog tick refreshes", () => {
  test("the most stale go first", () => {
    const accounts = [account("fresh"), account("stale"), account("middling")]
    const ages = [
      age("fresh", "2026-07-28T11:00:00.000Z"),
      age("stale", "2026-07-20T11:00:00.000Z"),
      age("middling", "2026-07-27T11:00:00.000Z"),
    ]

    expect(selectForRefresh(accounts, ages, 3).map((a) => a.id)).toEqual([
      "stale",
      "middling",
      "fresh",
    ])
  })

  /** A provider connected five minutes ago should show its models on the next tick, not last. */
  test("an account with no catalog at all outranks one merely refreshed a while ago", () => {
    const accounts = [account("old"), account("never")]
    const ages = [age("old", "2026-07-01T00:00:00.000Z")]

    expect(selectForRefresh(accounts, ages, 1).map((a) => a.id)).toEqual(["never"])
  })

  /**
   * The regression this file is named for. Non-refreshable accounts never acquire a `refreshed_at`,
   * so they sort first *forever* — filtering them after the cap would hand every tick to the same
   * accounts that cannot be refreshed and starve the ones that can.
   */
  test("accounts that can never be refreshed do not consume the batch", () => {
    const accounts = [
      account("locked-sub", { provider: "anthropic-oauth", status: "needs_reauth" }),
      account("aggregator", { provider: "openrouter" }),
      account("off", { status: "disabled" }),
      account("real"),
    ]

    expect(selectForRefresh(accounts, [], 2).map((a) => a.id)).toEqual(["real"])
  })

  /** A subscription's catalog comes from the Agent SDK's handshake, and the sweep asks for it too. */
  test("a healthy Claude subscription takes its turn like any HTTP account", () => {
    const accounts = [account("sub", { provider: "anthropic-oauth" }), account("real")]

    expect(selectForRefresh(accounts, [], 5).map((a) => a.id)).toEqual(["real", "sub"])
  })

  test("the cap is a rate limit, and the remainder is simply next tick's work", () => {
    const accounts = ["a", "b", "c", "d"].map((id) => account(id))
    const ages = [
      age("a", "2026-07-28T04:00:00.000Z"),
      age("b", "2026-07-28T01:00:00.000Z"),
      age("c", "2026-07-28T03:00:00.000Z"),
      age("d", "2026-07-28T02:00:00.000Z"),
    ]

    // Two per tick, oldest first: b and d now, then c and a once these two are stamped.
    expect(selectForRefresh(accounts, ages, 2).map((a) => a.id)).toEqual(["b", "d"])
  })

  test("equal staleness breaks on id, so two ticks with the same input choose the same accounts", () => {
    const accounts = [account("zeta"), account("alpha")]
    const same = [age("zeta", "2026-07-28T00:00:00.000Z"), age("alpha", "2026-07-28T00:00:00.000Z")]

    expect(selectForRefresh(accounts, same, 2).map((a) => a.id)).toEqual(["alpha", "zeta"])
  })

  test("a non-positive cap selects nothing rather than throwing or selecting everything", () => {
    expect(selectForRefresh([account("a")], [], 0)).toEqual([])
    expect(selectForRefresh([account("a")], [], -5)).toEqual([])
  })

  /**
   * `exhausted` and `needs_reauth` accounts stay in. A listing costs no tokens and spends no quota
   * window, so there is nothing to save by skipping them — and a credential that came back is
   * noticed sooner. Only `disabled`, the operator's own switch, is excluded.
   */
  test("a blocked account still has a catalog worth describing", () => {
    const accounts = [
      account("spent", { status: "exhausted" }),
      account("locked", { status: "needs_reauth" }),
      account("cooling", { status: "cooling_down" }),
    ]

    expect(selectForRefresh(accounts, [], 10).map((a) => a.id)).toEqual([
      "cooling",
      "locked",
      "spent",
    ])
  })
})

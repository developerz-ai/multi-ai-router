import { describe, expect, test } from "bun:test"
import type { AccountRow, ModelCatalogEntry } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import type { SdkModelListing } from "../../../src/providers"
import {
  type CatalogRefreshOutcome,
  createSubscriptionModelRefresh,
  refreshAccountCatalog,
  shippedSubscriptionCatalog,
} from "../../../src/services/models"

/**
 * One subscription's catalog refresh, through the same `refreshAccountCatalog` the sweep calls:
 * what is written for each of the lister's three answers, and what the login-completion wrapper
 * adds on top. The lister is a stub — no `claude` CLI is ever spawned here.
 */

const NOW = new Date("2026-07-28T12:00:00.000Z")

function sub(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "sub-1",
    label: "sub-1",
    provider: "anthropic-oauth",
    status: "active",
    authMaterial: null,
    configDir: "/data/claude/sub-1",
    billing: "subscription",
    weight: 100,
    priority: 0,
    ...overrides,
  } as AccountRow
}

function harness(answer: SdkModelListing | null) {
  const writes: { accountId: string; rows: readonly ModelCatalogEntry[] }[] = []
  const asked: string[] = []
  const logs: Record<string, unknown>[] = []
  const logger = createLogger({
    level: "debug",
    write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  })
  const deps = {
    catalog: {
      replaceForAccount: async (accountId: string, rows: readonly ModelCatalogEntry[]) => {
        writes.push({ accountId, rows })
      },
    },
    cipher: { decrypt: (envelope: string) => envelope },
    timeoutMs: 5_000,
    fetch: async () => {
      throw new Error("a subscription must never be fetched")
    },
    subscription: {
      lister: {
        list: async (input: { accountId: string }) => {
          asked.push(input.accountId)
          return answer
        },
      },
      timeoutMs: 30_000,
      logger,
    },
  }
  return { deps, writes, asked, logs }
}

describe("refreshing a Claude subscription's catalog", () => {
  test("a live answer is written as it came", async () => {
    const { deps, writes, asked } = harness({
      kind: "listed",
      models: [
        { id: "claude-opus-5", resolvedModel: null, displayName: null },
        { id: "opus", resolvedModel: "claude-opus-5", displayName: null },
      ],
    })

    const outcome = await refreshAccountCatalog(deps, sub(), NOW)

    expect(outcome).toEqual({ kind: "refreshed", models: 2, source: "live" })
    expect(asked).toEqual(["sub-1"])
    expect(
      writes[0]?.rows.map((row) => [row.modelId, row.listingSource, row.resolvedModel]),
    ).toEqual([
      ["claude-opus-5", "live", null],
      ["opus", "live", "claude-opus-5"],
    ])
  })

  test("an unavailable answer writes the shipped table and says so at info", async () => {
    const { deps, writes, logs } = harness(null)

    const outcome = await refreshAccountCatalog(deps, sub(), NOW)

    expect(outcome).toEqual({
      kind: "refreshed",
      models: shippedSubscriptionCatalog().length,
      source: "shipped",
    })
    expect(writes[0]?.rows).toEqual(shippedSubscriptionCatalog())
    expect(
      logs.find(
        (line) => line.msg === "subscription model listing unavailable; shipped table stands in",
      ),
    ).toMatchObject({ level: "info", accountId: "sub-1" })
  })

  test("an auth failure writes nothing — the rows it had stand until a human reconnects it", async () => {
    const { deps, writes, logs } = harness({ kind: "auth" })

    const outcome = await refreshAccountCatalog(deps, sub(), NOW)

    expect(outcome).toEqual({ kind: "skipped", reason: "agent-sdk:needs-reauth" })
    expect(writes).toEqual([])
    expect(logs.some((line) => line.level === "info" && line.reason === undefined)).toBe(true)
  })

  test("a subscription whose login never finished has nothing to spawn against", async () => {
    const { deps, writes, asked } = harness(null)

    const outcome = await refreshAccountCatalog(deps, sub({ configDir: null }), NOW)

    expect(outcome).toEqual({ kind: "skipped", reason: "agent-sdk:no-config-dir" })
    expect(asked).toEqual([])
    expect(writes).toEqual([])
  })
})

describe("the login-completion refresh", () => {
  function wrapper(options: {
    readonly row?: AccountRow
    readonly outcome?: CatalogRefreshOutcome
    readonly throws?: boolean
  }) {
    const refreshed: string[] = []
    let warmed = 0
    const logs: Record<string, unknown>[] = []
    const refresh = createSubscriptionModelRefresh({
      accounts: { findById: async (id) => (options.row?.id === id ? options.row : undefined) },
      refresh: async (account) => {
        refreshed.push(account.id)
        if (options.throws === true) throw new Error("the volume is gone")
        return options.outcome ?? { kind: "refreshed", models: 13, source: "live" }
      },
      onRefreshed: async () => {
        warmed += 1
      },
      logger: createLogger({
        level: "debug",
        write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
      }),
      now: () => NOW,
    })
    return { refresh, refreshed, warmed: () => warmed, logs }
  }

  test("takes a row or an id, refreshes it, and warms the store before it answers", async () => {
    const byRow = wrapper({})
    expect(await byRow.refresh(sub())).toEqual({ kind: "refreshed", models: 13, source: "live" })
    expect(byRow.refreshed).toEqual(["sub-1"])
    expect(byRow.warmed()).toBe(1)

    const byId = wrapper({ row: sub() })
    expect(await byId.refresh("sub-1")).toMatchObject({ kind: "refreshed" })
    expect(byId.refreshed).toEqual(["sub-1"])
  })

  test("an unknown id is a skip, not a throw", async () => {
    const { refresh, refreshed, warmed } = wrapper({})
    expect(await refresh("nobody")).toEqual({ kind: "skipped", reason: "account:unknown" })
    expect(refreshed).toEqual([])
    expect(warmed()).toBe(0)
  })

  test("a skip does not warm the store — nothing changed", async () => {
    const { refresh, warmed } = wrapper({
      outcome: { kind: "skipped", reason: "agent-sdk:needs-reauth" },
    })
    await refresh(sub())
    expect(warmed()).toBe(0)
  })

  test("never throws across the seam: a login must not fail over a listing", async () => {
    const { refresh, logs } = wrapper({ throws: true })
    const outcome = await refresh(sub())
    expect(outcome).toMatchObject({ kind: "failed" })
    expect(logs.some((line) => line.level === "warn")).toBe(true)
  })
})

import { describe, expect, test } from "bun:test"
import type { AccountStatus } from "@multi-ai-router/core"
import type { AccountRow } from "@multi-ai-router/db"
import { createRecheckService } from "../../../src/services/accounts"
import type { AuditEventInput } from "../../../src/services/admin"

/**
 * "Re-check now" — the button that exists because providers reset early.
 *
 * The two properties worth pinning are that the cooldown cannot be bypassed from the client, and
 * that a refused re-check is not an error. Both are stated in CLAUDE.md's frontend section; both
 * are the kind of thing a later refactor quietly breaks.
 *
 * The third arrived with durable health: a standing `exhausted` on the row outlives the process
 * that observed it, so the button has to lift the stored block as well as the in-memory one, and
 * has to lift *only* that one.
 */

const NOW = new Date("2026-01-01T12:00:00.000Z")

function accountRow(id: string, status: AccountStatus = "cooling_down"): AccountRow {
  return {
    id,
    label: id,
    provider: "zai",
    status,
    authMaterial: null,
    configDir: null,
    tokenExpiresAt: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    weight: 100,
    priority: 0,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function harness(cooldownSeconds = 60, rows = [accountRow("a"), accountRow("b")]) {
  const resets: string[] = []
  const audited: AuditEventInput[] = []
  let refreshes = 0
  let clock = NOW

  const service = createRecheckService({
    accounts: {
      list: async () => rows,
      findById: async (id) => rows.find((row) => row.id === id),
      // The same guard the repository applies, so a test cannot pass on a statement that would
      // have overwritten `disabled` in postgres.
      updateStatusWhen: async (id, from, to, now) => {
        const index = rows.findIndex((row) => row.id === id)
        const row = rows[index]
        if (row === undefined || !from.includes(row.status)) return undefined
        const next: AccountRow = { ...row, status: to, updatedAt: now }
        rows[index] = next
        return next
      },
    },
    health: { reset: (accountId) => resets.push(accountId) },
    audit: {
      record: async (event) => {
        audited.push(event)
      },
    },
    refreshCatalog: async () => {
      refreshes += 1
    },
    cooldownSeconds,
    now: () => clock,
  })

  return {
    service,
    rows,
    resets,
    audited,
    refreshes: () => refreshes,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
  }
}

describe("recheck", () => {
  test("clears the account's breaker marks, which is what makes it eligible again", async () => {
    const { service, resets } = harness()
    const result = await service.recheck("a")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.rechecked).toBe(true)
    // The same call the cooldown-expiry path makes. One recovery path, not two.
    expect(resets).toEqual(["a"])
  })

  test("a second press inside the cooldown is refused server-side, not by the client", async () => {
    const { service, resets } = harness(60)
    await service.recheck("a")
    const second = await service.recheck("a")

    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.rechecked).toBe(false)
    // The refusal is real: the breaker was not cleared a second time.
    expect(resets).toEqual(["a"])
  })

  test("a refused re-check is a normal response carrying when the next one is allowed", async () => {
    const { service } = harness(60)
    const first = await service.recheck("a")
    const second = await service.recheck("a")

    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    // Not a 429: the operator asked for a state the system is already in.
    expect(second.value.nextAllowedAt).toBe(first.value.nextAllowedAt)
    expect(second.value.lastCheckedAt).toBe(first.value.lastCheckedAt)
  })

  test("the cooldown expires", async () => {
    const { service, resets, advance } = harness(60)
    await service.recheck("a")
    advance(60_000)
    const again = await service.recheck("a")

    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.value.rechecked).toBe(true)
    expect(resets).toEqual(["a", "a"])
  })

  test("recheck-all applies the cooldown per account, so it is not a way to double the rate", async () => {
    const { service, resets } = harness(60)
    await service.recheck("a")
    const all = await service.recheckAll()

    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.value.find((entry) => entry.accountId === "a")?.rechecked).toBe(false)
    expect(all.value.find((entry) => entry.accountId === "b")?.rechecked).toBe(true)
    expect(resets).toEqual(["a", "b"])
  })

  test("a re-check that took effect is audited; a refused one writes nothing", async () => {
    const { service, audited } = harness(60)
    await service.recheck("a")
    await service.recheck("a")

    expect(audited).toHaveLength(1)
    expect(audited[0]?.kind).toBe("account.rechecked")
    expect(audited[0]?.subjectId).toBe("a")
    // No probe was injected, so nothing claims to know whether the account is logged in.
    expect(audited[0]?.detail).toEqual({ provider: "zai" })
  })

  test("lifts a stored exhausted, or the button would be pressing against a durable row", async () => {
    const { service, rows, refreshes } = harness(60, [accountRow("a", "exhausted")])
    const result = await service.recheck("a")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.clearedStatus).toBe("exhausted")
    expect(rows[0]?.status).toBe("active")
    // Read-after-write: the console re-reads the list the moment this returns.
    expect(refreshes()).toBe(1)
  })

  test("never lifts a disabled — that is the operator's own switch, not a block we observed", async () => {
    const { service, rows, refreshes } = harness(60, [accountRow("a", "disabled")])
    const result = await service.recheck("a")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.clearedStatus).toBeUndefined()
    expect(rows[0]?.status).toBe("disabled")
    // Nothing changed, so nothing is re-read.
    expect(refreshes()).toBe(0)
  })

  test("never lifts a needs_reauth — only a completed login ends that one", async () => {
    const { service, rows } = harness(60, [accountRow("a", "needs_reauth")])
    const result = await service.recheck("a")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.clearedStatus).toBeUndefined()
    expect(rows[0]?.status).toBe("needs_reauth")
  })

  test("a lifted block is audited, so the log distinguishes it from a reset countdown", async () => {
    const { service, audited } = harness(60, [accountRow("a", "exhausted")])
    await service.recheck("a")

    expect(audited[0]?.detail).toEqual({ provider: "zai", clearedStatus: "exhausted" })
  })

  test("recheck-all refreshes the catalog once, however many rows it cleared", async () => {
    const { service, refreshes } = harness(60, [
      accountRow("a", "exhausted"),
      accountRow("b", "exhausted"),
    ])
    const all = await service.recheckAll()

    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.value.every((entry) => entry.clearedStatus === "exhausted")).toBe(true)
    expect(refreshes()).toBe(1)
  })

  test("an unknown account id is a 404, not a silent success", async () => {
    const { service } = harness()
    const result = await service.recheck("missing")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.status).toBe(404)
  })
})

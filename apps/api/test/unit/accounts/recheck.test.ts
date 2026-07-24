import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { createRecheckService } from "../../../src/services/accounts"

/**
 * "Re-check now" — the button that exists because providers reset early.
 *
 * The two properties worth pinning are that the cooldown cannot be bypassed from the client, and
 * that a refused re-check is not an error. Both are stated in CLAUDE.md's frontend section; both
 * are the kind of thing a later refactor quietly breaks.
 */

const NOW = new Date("2026-01-01T12:00:00.000Z")

function accountRow(id: string): AccountRow {
  return {
    id,
    label: id,
    provider: "zai",
    status: "cooling_down",
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

function harness(cooldownSeconds = 60) {
  const rows = [accountRow("a"), accountRow("b")]
  const resets: string[] = []
  let clock = NOW

  const service = createRecheckService({
    accounts: {
      list: async () => rows,
      findById: async (id) => rows.find((row) => row.id === id),
    },
    health: { reset: (accountId) => resets.push(accountId) },
    cooldownSeconds,
    now: () => clock,
  })

  return {
    service,
    resets,
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

  test("an unknown account id is a 404, not a silent success", async () => {
    const { service } = harness()
    const result = await service.recheck("missing")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.status).toBe(404)
  })
})

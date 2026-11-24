import { describe, expect, test } from "bun:test"
import { decideRepair, type RepairFacts } from "../../../src/services/accounts/egress/decide"
import { egressHarness, listed, NOW, PASSWORD, vendorProxy } from "./egress-fixtures"

const D1 = vendorProxy("d-1")
const D2 = vendorProxy("d-2", { country: "DE" })
const D3 = vendorProxy("d-3")

async function dead(options: Parameters<typeof egressHarness>[0] = {}) {
  const h = egressHarness({
    listing: listed(D1, D2, D3),
    alive: [D2.address, D3.address],
    ...options,
  })
  const row = await h.add()
  await h.service.set(row.id, { vendor: "webshare", id: "d-1", replace: "on-failure" })
  return { ...h, row }
}

describe("a dead proxy is replaced", () => {
  test("only after the threshold, same country first, sticky, audited and alerted", async () => {
    const h = await dead()
    for (let i = 0; i < 2; i++) expect(await h.sweep()).toMatchObject({ checked: 1, swaps: 0 })
    expect(await h.sweep()).toMatchObject({ checked: 1, swaps: 1, partial: false })
    // d-2 sorts first and is alive; d-3 shares the country.
    expect(await h.proxyOf(h.row.id)).toMatchObject({ vendorId: "d-3", replace: "on-failure" })
    expect(h.egress.health.get(h.row.id)).toMatchObject({
      swaps: 1,
      repair: "idle",
      consecutiveFailures: 0,
    })
    expect(h.store.rows.audit.at(-1)).toMatchObject({
      kind: "account.egress_proxy_replaced",
      detail: {
        vendor: "webshare",
        from: D1.address,
        to: D3.address,
        reason: "unreachable",
        failures: 3,
      },
    })
    expect(h.lines).toMatchObject([
      {
        msg: "egress proxy replaced",
        fields: { accountId: h.row.id, from: D1.address, to: D3.address },
      },
    ])
    const probes = h.world.probes.length
    expect(await h.sweep()).toMatchObject({ swaps: 0 })
    expect(h.world.probes.length).toBe(probes + 1)
    expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-3")
    expect(await h.visible()).not.toContain(PASSWORD)
  })

  test("a swap touches no account generation, so no breaker or recovery fence moves", async () => {
    const h = await dead()
    const before = await h.store.accounts.findById(h.row.id)
    for (let i = 0; i < 3; i++) await h.sweep()
    const after = await h.store.accounts.findById(h.row.id)
    for (const field of [
      "lifecycleVersion",
      "healthRecoveryVersion",
      "authRecoveryVersion",
      "status",
      "authMaterial",
    ] as const)
      expect(after?.[field]).toEqual(before?.[field] as never)
  })

  test("an answer that recovers resets the count", async () => {
    const h = await dead()
    await h.sweep()
    await h.sweep()
    h.world.alive.add(D1.address)
    await h.sweep()
    h.world.alive.delete(D1.address)
    await h.sweep()
    await h.sweep()
    expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-1")
  })

  test("dead, and gone from a complete list or marked invalid, says which", async () => {
    for (const [listing, reason] of [
      [listed(D2, D3), "not_listed"],
      [listed({ ...D1, valid: false }, D2, D3), "vendor_invalid"],
    ] as const) {
      const h = await dead()
      h.world.listing = listing
      for (let i = 0; i < 3; i++) await h.sweep()
      expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-3")
      expect(h.store.rows.audit.at(-1)?.detail).toMatchObject({ reason })
    }
  })

  test("new credentials for the same proxy are stored in place: no swap, no cooldown spent", async () => {
    const h = await dead({ alive: [] })
    const fresh = { ...D1, url: D1.url.replace(PASSWORD, "rotated") }
    h.world.listing = listed(fresh, D2, D3)
    h.world.onProbe = () => {
      // Dead under the old password, alive under the new one.
      // Two probes per dead check: its upstream, then the neutral control.
      if (h.world.probes.length === 7) h.world.alive.add(D1.address)
    }
    for (let i = 0; i < 2; i++) await h.sweep()
    expect(await h.sweep()).toMatchObject({ reseals: 1, swaps: 0 })
    const stored = await h.proxyOf(h.row.id)
    expect(stored?.vendorId).toBe("d-1")
    expect(h.cipher.decrypt(stored?.sealed ?? "")).toContain("rotated")
    expect(h.egress.health.get(h.row.id)).toMatchObject({ swaps: 0, lastSwapAt: null })
  })
})

describe("and stays put when it must", () => {
  test("a manual account is never moved", async () => {
    const h = await dead()
    await h.service.setReplace(h.row.id, { replace: "manual" })
    for (let i = 0; i < 10; i++) await h.sweep()
    expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-1")
  })

  test("a live proxy that declines the target is shown and never counted", async () => {
    const h = await dead({ outcomes: { [D1.address]: "refused" } })
    for (let i = 0; i < 10; i++) await h.sweep()
    expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-1")
    expect(h.egress.health.get(h.row.id)).toMatchObject({
      lastOutcome: "refused",
      consecutiveFailures: 0,
    })
  })

  test("an upstream that drops this address is not a dead proxy, however long it lasts", async () => {
    const h = await dead({ alive: [D1.address, D2.address, D3.address] })
    h.world.blocked.add(D1.address)
    for (let i = 0; i < 20; i++) await h.sweep()
    expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-1")
    expect(h.egress.health.get(h.row.id)).toMatchObject({
      lastOutcome: "refused",
      consecutiveFailures: 0,
    })
  })

  test("a proxy that answers is kept whatever its vendor lists, and the overview says so", async () => {
    for (const [listing, word] of [
      [listed(D2, D3), { listed: false, valid: null }],
      [listed({ ...D1, valid: false }, D2, D3), { listed: true, valid: false }],
    ] as const) {
      const h = await dead({ alive: [D1.address, D2.address, D3.address] })
      h.world.listing = listing
      for (let i = 0; i < 10; i++) await h.sweep()
      expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-1")
      expect(await h.service.list()).toMatchObject({ value: { assigned: [word] } })
    }
  })

  test("consecutive means consecutive: a refusal is an answer and restarts the count", async () => {
    const h = await dead()
    for (let i = 0; i < 2; i++) await h.sweep()
    h.world.outcomes[D1.address] = "refused"
    await h.sweep()
    delete h.world.outcomes[D1.address]
    for (let i = 0; i < 2; i++) await h.sweep()
    expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-1")
  })

  test("an operator switching it to manual mid-sweep wins", async () => {
    const h = await dead()
    for (let i = 0; i < 2; i++) await h.sweep()
    h.world.onProbe = async (address) => {
      if (address === D3.address) await h.service.setReplace(h.row.id, { replace: "manual" })
    }
    expect(await h.sweep()).toMatchObject({ swaps: 0 })
    expect(await h.proxyOf(h.row.id)).toMatchObject({ vendorId: "d-1", replace: "manual" })
  })

  test("the same id at a new address is a move: exclusive, and under the cooldown", async () => {
    const moved = vendorProxy("d-1", { address: "203.0.113.99:6754" })
    const h = await dead({ alive: [moved.address, D2.address, D3.address] })
    h.world.listing = listed(moved, D2, D3)
    for (let i = 0; i < 3; i++) await h.sweep()
    expect(await h.proxyOf(h.row.id)).toMatchObject({ vendorId: "d-1", address: moved.address })
    expect(h.egress.health.get(h.row.id)).toMatchObject({ swaps: 1 })
    h.world.alive.delete(moved.address)
    h.world.listing = listed(vendorProxy("d-1", { address: D2.address }), D3)
    for (let i = 0; i < 5; i++) await h.sweep()
    expect((await h.proxyOf(h.row.id))?.address).toBe(moved.address)
    expect(h.egress.health.get(h.row.id)?.repair).toBe("cooldown")
  })

  test("one swap per cooldown, then it may move again", async () => {
    const h = await dead()
    for (let i = 0; i < 3; i++) await h.sweep()
    h.world.alive.delete(D3.address)
    for (let i = 0; i < 5; i++) await h.sweep()
    expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-3")
    expect(h.egress.health.get(h.row.id)?.repair).toBe("cooldown")
    await h.sweep(6 * 60)
    expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-2")
  })

  test("a cooldown that cannot be recorded leaves the account where it was", async () => {
    const h = await dead()
    const record = h.egress.repository.recordRepair
    let failing = true
    h.egress.repository.recordRepair = async (input) => {
      if (failing) throw new Error("health write failed")
      await record(input)
    }
    for (let i = 0; i < 4; i++) await h.sweep()
    expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-1")
    expect(h.store.rows.audit.map((event) => event.kind)).not.toContain(
      "account.egress_proxy_replaced",
    )

    failing = false
    await h.sweep()
    expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-3")
    expect(h.egress.health.get(h.row.id)).toMatchObject({ swaps: 1 })
    expect(h.egress.health.get(h.row.id)?.lastSwapAt).not.toBeNull()
  })

  test("an incomplete or failed listing is no evidence and no inventory", async () => {
    for (const listing of [
      { ok: true as const, proxies: [D2, D3], complete: false },
      { ok: false as const, code: "timeout" as const },
    ]) {
      const h = await dead()
      h.world.listing = listing
      for (let i = 0; i < 2; i++) await h.sweep()
      expect(await h.sweep()).toMatchObject({ swaps: 0, partial: true })
      expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-1")
      expect(h.egress.health.get(h.row.id)).toMatchObject({
        lastOutcome: "unreachable",
        repair: "vendor_unavailable",
      })
    }
  })

  test("a router-side outage kills every candidate, so nothing moves; it alerts once", async () => {
    const h = await dead({ alive: [] })
    for (let i = 0; i < 6; i++) await h.sweep()
    expect((await h.proxyOf(h.row.id))?.vendorId).toBe("d-1")
    expect(h.egress.health.get(h.row.id)?.repair).toBe("no_candidate")
    expect(h.lines.filter((line) => line.msg === "egress proxy has no replacement")).toHaveLength(1)
  })

  test("another account's proxy is never taken, even by two repairs in one sweep", async () => {
    const h = await dead({ listing: listed(D1, D2, D3), alive: [D3.address] })
    const other = await h.add()
    await h.service.set(other.id, { vendor: "webshare", id: "d-2", replace: "on-failure" })
    for (let i = 0; i < 3; i++) await h.sweep()
    const held = [await h.proxyOf(h.row.id), await h.proxyOf(other.id)].map((p) => p?.vendorId)
    expect(held.filter((id) => id === "d-3")).toHaveLength(1)
    expect(new Set(held).size).toBe(2)
  })

  test("an operator's edit made during the sweep wins", async () => {
    const h = await dead()
    for (let i = 0; i < 2; i++) await h.sweep()
    h.world.onProbe = async (address) => {
      if (address === D3.address) await h.service.set(h.row.id, { url: "http://mine.test:1" })
    }
    expect(await h.sweep()).toMatchObject({ swaps: 0 })
    expect((await h.proxyOf(h.row.id))?.address).toBe("mine.test:1")
  })

  test("a disabled account is not checked, and one broken row does not stop the rest", async () => {
    const h = await dead()
    const off = await h.add()
    await h.service.set(off.id, { vendor: "webshare", id: "d-2" })
    await h.store.accounts.disable(off.id, NOW)
    const broken = await h.add()
    await h.service.set(broken.id, { url: "http://x.test:1" })
    const held = h.store.rows.accounts.find((row) => row.id === broken.id)
    if (held?.egressProxy != null) held.egressProxy = { ...held.egressProxy, sealed: "v1.k1.bad" }
    expect(await h.sweep()).toMatchObject({ checked: 1, failed: 1 })
    expect(h.egress.health.has(off.id)).toBe(false)
  })

  test("a shutdown mid-sweep records nothing about a probe it cut short", async () => {
    const h = await dead()
    const stop = new AbortController()
    h.world.onProbe = () => stop.abort()
    const result = await h.service.sweep({
      now: NOW,
      logger: { info: () => {}, warn: () => {} },
      signal: stop.signal,
    })
    expect(result).toMatchObject({ checked: 0, partial: true })
    expect(h.egress.health.size).toBe(0)
  })

  test("no account has a proxy: no vendor is asked", async () => {
    const h = egressHarness({ listing: listed(D1) })
    await h.add()
    expect(await h.sweep()).toMatchObject({ checked: 0, partial: false })
    expect(h.world.listings).toBe(0)
  })
})

test("a decision has no field an AI provider's answer could arrive in", () => {
  const facts: RepairFacts = {
    proxy: {
      address: D1.address,
      sealed: "s",
      vendor: "webshare",
      vendorId: "d-1",
      country: "US",
      replace: "on-failure",
    },
    url: D1.url,
    consecutiveFailures: 0,
    lastSwapAt: null,
    listing: listed(D1, D3),
    taken: { addresses: new Set(), ids: new Set() },
    now: NOW,
    threshold: 3,
    cooldownMs: 1,
  }
  expect(decideRepair(facts)).toEqual({ kind: "none" })
  expect(Object.keys(facts).sort()).toEqual([
    "consecutiveFailures",
    "cooldownMs",
    "lastSwapAt",
    "listing",
    "now",
    "proxy",
    "taken",
    "threshold",
    "url",
  ])
})

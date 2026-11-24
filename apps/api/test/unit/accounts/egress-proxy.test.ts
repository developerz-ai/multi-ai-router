import { describe, expect, test } from "bun:test"
import { setEgressProxyBody, testEgressProxyBody } from "../../../src/services/accounts"
import { egressHarness, listed, PASSWORD, vendorProxy } from "./egress-fixtures"

const D1 = vendorProxy("d-1")

describe("an account's egress proxy, refusals first", () => {
  test("a provider that signs in is refused one: part of its traffic would go direct", async () => {
    const h = egressHarness()
    for (const provider of ["anthropic-oauth", "openai-oauth"] as const) {
      const row = await h.add(provider)
      expect(await h.service.set(row.id, { url: "http://p.test:1" })).toMatchObject({
        ok: false,
        failure: { status: 400, code: "egress_proxy_unsupported" },
      })
    }
  })

  test("a plain-http endpoint holding a credential is refused: the proxy would read the key", async () => {
    const h = egressHarness()
    const add = (authMaterial: string | null, baseUrl: string) =>
      h.store.accounts.create({ label: "c", provider: "openai-compatible", baseUrl, authMaterial })
    const set = async (row: { id: string }) => h.service.set(row.id, { url: "http://p.test:1" })
    expect(await set(await add("sealed", "http://h.test/v1"))).toMatchObject({
      failure: { code: "egress_proxy_plaintext" },
    })
    expect(await set(await add(null, "http://h.test/v1"))).toMatchObject({ ok: true })
    expect(await set(await add("sealed", "https://h.test/v1"))).toMatchObject({ ok: true })
  })

  test("anything but an http(s) proxy address is refused", async () => {
    expect(setEgressProxyBody.safeParse({ url: "socks5://p.test:1" }).success).toBe(false)
    expect(testEgressProxyBody.safeParse({ url: "socks5://p.test:1" }).success).toBe(false)
    const h = egressHarness()
    const row = await h.add()
    for (const url of ["http://p.test:1/path", "http://p.test:1?q=1"])
      expect(await h.service.set(row.id, { url })).toMatchObject({
        failure: { code: "egress_proxy_invalid" },
      })
  })

  test("no vendor key: the overview says so, and a vendor choice is refused", async () => {
    const h = egressHarness()
    const row = await h.add()
    expect(await h.service.list()).toMatchObject({
      ok: true,
      value: {
        configured: false,
        vendors: [{ vendor: "webshare", state: "off", error: null }],
        proxies: [],
      },
    })
    expect(await h.service.set(row.id, { vendor: "webshare", id: "d-1" })).toMatchObject({
      failure: { status: 409, code: "webshare_off" },
    })
  })

  test("a vendor that is down hides only its own inventory, and a choice from it is retryable", async () => {
    const h = egressHarness({ listing: listed(D1) })
    const row = await h.add()
    await h.service.set(row.id, { vendor: "webshare", id: "d-1" })
    h.world.listing = { ok: false, code: "timeout" }
    expect(await h.service.list()).toMatchObject({
      ok: true,
      value: {
        vendors: [{ state: "unavailable", error: { code: "timeout" } }],
        assigned: [{ account: { id: row.id }, address: D1.address, listed: null }],
      },
    })
    expect(await h.service.set(row.id, { vendor: "webshare", id: "d-1" })).toMatchObject({
      failure: { status: 503, code: "webshare_unavailable", retryAfterSeconds: expect.any(Number) },
    })
  })

  test("an id the vendor does not list, and a vendor nobody registered, store nothing", async () => {
    const h = egressHarness({ listing: listed(D1) })
    const row = await h.add()
    for (const [choice, code] of [
      [{ vendor: "webshare", id: "nope" }, "unknown_proxy"],
      [{ vendor: "other", id: "d-1" }, "unknown_proxy_vendor"],
    ] as const)
      expect(await h.service.set(row.id, choice)).toMatchObject({ failure: { code } })
    expect(await h.proxyOf(row.id)).toBeNull()
  })
})

describe("assigning one", () => {
  test("a chosen one is stored sealed with its identity, audited, live at once, and listed", async () => {
    const h = egressHarness({ listing: listed(D1, vendorProxy("d-2")) })
    const row = await h.add()
    const before = await h.store.accounts.findById(row.id)
    const set = await h.service.set(row.id, {
      vendor: "webshare",
      id: "d-1",
      replace: "on-failure",
    })
    expect(set).toMatchObject({ ok: true, value: { egressProxy: D1.address } })

    const stored = await h.proxyOf(row.id)
    expect(stored).toMatchObject({
      vendor: "webshare",
      vendorId: "d-1",
      country: "US",
      replace: "on-failure",
    })
    expect(h.cipher.decrypt(stored?.sealed ?? "")).toBe(D1.url)
    expect(h.world.refreshed).toBe(1)
    const after = await h.store.accounts.findById(row.id)
    expect(after?.lifecycleVersion).toBe(before?.lifecycleVersion ?? -1)

    const overview = await h.service.list()
    expect(overview).toMatchObject({
      value: {
        proxies: [
          { id: "d-1", location: "Buffalo, US", accounts: [{ id: row.id, label: "openrouter" }] },
          { id: "d-2", accounts: [] },
        ],
        assigned: [{ listed: true, replace: "on-failure", health: { outcome: null, swaps: 0 } }],
      },
    })
    expect(await h.visible()).not.toContain(PASSWORD)
  })

  test("cleared, the account is direct again", async () => {
    const h = egressHarness()
    const row = await h.add()
    await h.service.set(row.id, { url: "https://user:pw@p.test" })
    expect((await h.proxyOf(row.id))?.address).toBe("p.test:443")
    expect(await h.service.clear(row.id)).toMatchObject({ ok: true, value: { egressProxy: null } })
  })
})

describe("the replace mode", () => {
  test("a custom proxy cannot be replaced on failure", async () => {
    const h = egressHarness({ listing: listed(D1) })
    const row = await h.add()
    const custom = { url: "http://p.test:1" } as const
    expect(await h.service.set(row.id, { ...custom, replace: "on-failure" })).toMatchObject({
      failure: { status: 400, code: "replace_needs_vendor" },
    })
    await h.service.set(row.id, custom)
    expect(await h.service.setReplace(row.id, { replace: "on-failure" })).toMatchObject({
      failure: { code: "replace_needs_vendor" },
    })
  })

  test("a proxy chosen before identities were stored is matched by its address", async () => {
    const h = egressHarness({ listing: listed(D1) })
    const row = await h.add()
    await h.service.set(row.id, { url: D1.url })
    expect(await h.service.setReplace(row.id, { replace: "on-failure" })).toMatchObject({
      ok: true,
    })
    expect(await h.proxyOf(row.id)).toMatchObject({ vendorId: "d-1", replace: "on-failure" })
  })

  test("a mode changed while the vendor was being asked is the one kept", async () => {
    const h = egressHarness({ listing: listed(vendorProxy("d-1"), vendorProxy("d-2")) })
    const row = await h.add()
    await h.service.set(row.id, { vendor: "webshare", id: "d-1", replace: "on-failure" })
    h.world.onList = async () => {
      h.world.onList = undefined
      await h.service.setReplace(row.id, { replace: "manual" })
    }
    await h.service.set(row.id, { vendor: "webshare", id: "d-2" })
    expect(await h.proxyOf(row.id)).toMatchObject({ vendorId: "d-2", replace: "manual" })
  })

  test("it survives a change of proxy, and an account with none refuses it", async () => {
    const h = egressHarness({ listing: listed(D1, vendorProxy("d-2")) })
    const row = await h.add()
    expect(await h.service.setReplace(row.id, { replace: "manual" })).toMatchObject({
      failure: { code: "egress_proxy_none" },
    })
    await h.service.set(row.id, { vendor: "webshare", id: "d-1", replace: "on-failure" })
    await h.service.set(row.id, { vendor: "webshare", id: "d-2" })
    expect((await h.proxyOf(row.id))?.replace).toBe("on-failure")
  })
})

describe("testing one", () => {
  test("an account's own: reaches its upstream, is recorded, never counts, and has a cooldown", async () => {
    const h = egressHarness({ listing: listed(D1) })
    const row = await h.add()
    await h.service.set(row.id, { vendor: "webshare", id: "d-1" })
    expect(await h.service.testAccount(row.id)).toMatchObject({
      ok: true,
      value: { outcome: "unreachable", latencyMs: 12 },
    })
    expect(h.world.probes.map((probe) => probe.target)).toEqual([
      "openrouter.ai:443",
      "example.com:443",
    ])
    expect(h.egress.health.get(row.id)).toMatchObject({
      lastOutcome: "unreachable",
      consecutiveFailures: 0,
    })
    expect(await h.service.testAccount(row.id)).toMatchObject({
      failure: { status: 429, code: "proxy_test_cooldown", retryAfterSeconds: 60 },
    })
    h.clock.now = new Date(h.clock.now.getTime() + 60_000)
    expect(await h.service.testAccount(row.id)).toMatchObject({ ok: true })
  })

  test("one not assigned yet stores nothing", async () => {
    const h = egressHarness({ alive: ["p.test:1"] })
    expect(await h.service.test({ url: "http://u:p@p.test:1" })).toMatchObject({
      ok: true,
      value: { outcome: "ok" },
    })
    expect(h.world.probes[0]?.target).toBe("example.com:443")
    expect(h.egress.health.size).toBe(0)
  })
})

import { describe, expect, test } from "bun:test"
import { createEgressProxyService, setEgressProxyBody } from "../../../src/services/accounts"
import { createAuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { createMemoryStore } from "../../support/memory-store"
import { silentLogger } from "../../support/silent-logger"

const PASSWORD = "webshare-pw"
const KEY = "webshare-api-key"
const NOW = new Date("2026-11-23T21:00:00.000Z")

const PAGE = {
  results: [
    {
      id: "d-1",
      username: "user",
      password: PASSWORD,
      proxy_address: "203.0.113.7",
      port: 6754,
      valid: true,
      country_code: "US",
      city_name: "Buffalo",
    },
  ],
}

function harness(apiKey: string | null, answer: () => Response | Promise<Response>) {
  const store = createMemoryStore()
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
  let refreshed = 0
  const service = createEgressProxyService({
    accounts: store.accounts,
    cipher,
    audit: createAuditRecorder(store.audit, silentLogger()),
    now: () => NOW,
    coherence: {
      refreshCatalog: async () => {
        refreshed += 1
      },
    },
    webshare: { apiKey, timeoutMs: 1000 },
    fetch: (async () => answer()) as unknown as typeof fetch,
  })
  const add = (provider: "openrouter" | "anthropic-oauth" | "openai-oauth") =>
    store.accounts.create({ label: provider, provider })
  return { service, store, cipher, add, refreshed: () => refreshed }
}

const unused = () => {
  throw new Error("Webshare must not be called")
}

describe("an account's egress proxy, refusals first", () => {
  test("a provider that signs in is refused one: part of its traffic would go direct", async () => {
    const { service, add } = harness(null, unused)
    for (const provider of ["anthropic-oauth", "openai-oauth"] as const) {
      const row = await add(provider)
      expect(await service.set(row.id, { url: "http://p.test:1" })).toMatchObject({
        ok: false,
        failure: { status: 400, code: "egress_proxy_unsupported" },
      })
    }
  })

  test("anything but an http(s) proxy address is refused", async () => {
    expect(setEgressProxyBody.safeParse({ url: "socks5://p.test:1" }).success).toBe(false)
    const { service, add } = harness(null, unused)
    const row = await add("openrouter")
    expect(await service.set(row.id, { url: "http://p.test:1/path" })).toMatchObject({
      ok: false,
      failure: { code: "egress_proxy_invalid" },
    })
  })

  test("no key: the list says so, and a Webshare choice is refused", async () => {
    const { service, add } = harness(null, unused)
    const row = await add("openrouter")
    expect(await service.list()).toEqual({ ok: true, value: { configured: false, proxies: [] } })
    expect(await service.set(row.id, { vendor: "webshare", id: "d-1" })).toMatchObject({
      ok: false,
      failure: { code: "webshare_off" },
    })
  })

  test("a Webshare failure is told plainly and quotes nothing it answered", async () => {
    for (const answer of [
      () => new Response(`bad ${KEY}`, { status: 401 }),
      () => Response.json({ results: [{ password: PASSWORD }] }),
      () => Promise.reject(new Error(`failed with ${KEY}`)),
    ]) {
      const { service } = harness(KEY, answer)
      const listed = await service.list()
      expect(listed).toMatchObject({ ok: false, failure: { code: "webshare_unavailable" } })
      expect(JSON.stringify(listed)).not.toMatch(/webshare-pw|webshare-api-key/)
    }
  })

  test("an id Webshare does not list is refused and nothing is stored", async () => {
    const { service, store, add } = harness(KEY, () => Response.json(PAGE))
    const row = await add("openrouter")
    expect(await service.set(row.id, { vendor: "webshare", id: "nope" })).toMatchObject({
      ok: false,
    })
    expect((await store.accounts.findById(row.id))?.egressProxy).toBeNull()
  })
})

describe("an account's egress proxy", () => {
  test("the list names addresses and never a password", async () => {
    const { service } = harness(KEY, () => Response.json(PAGE))
    const listed = await service.list()
    expect(listed).toEqual({
      ok: true,
      value: {
        configured: true,
        proxies: [
          {
            vendor: "webshare",
            id: "d-1",
            address: "203.0.113.7:6754",
            location: "Buffalo, US",
            valid: true,
          },
        ],
      },
    })
  })

  test("a chosen one is stored sealed, shown as host:port, audited, and live at once", async () => {
    const { service, store, cipher, add, refreshed } = harness(KEY, () => Response.json(PAGE))
    const row = await add("openrouter")
    const set = await service.set(row.id, { vendor: "webshare", id: "d-1" })

    expect(set).toMatchObject({ ok: true, value: { egressProxy: "203.0.113.7:6754" } })
    expect(JSON.stringify(set)).not.toContain(PASSWORD)
    const stored = (await store.accounts.findById(row.id))?.egressProxy
    expect(stored?.sealed).not.toContain(PASSWORD)
    expect(cipher.decrypt(stored?.sealed ?? "")).toBe(`http://user:${PASSWORD}@203.0.113.7:6754`)
    expect(refreshed()).toBe(1)
    expect(JSON.stringify(store.rows.audit)).not.toContain(PASSWORD)
  })

  test("cleared, the account is direct again", async () => {
    const { service, store, add } = harness(null, unused)
    const row = await add("openrouter")
    await service.set(row.id, { url: "https://user:pw@p.test" })
    expect((await store.accounts.findById(row.id))?.egressProxy?.address).toBe("p.test:443")
    expect(await service.clear(row.id)).toMatchObject({ ok: true, value: { egressProxy: null } })
  })
})

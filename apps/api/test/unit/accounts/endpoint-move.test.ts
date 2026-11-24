import { describe, expect, test } from "bun:test"
import {
  createAccountBody,
  createAccountsService,
  testNowBody,
  updateAccountBody,
} from "../../../src/services/accounts"
import { createAuditRecorder } from "../../../src/services/admin"
import { accountDeletionFixture } from "../../support/account-deletion"
import { createMemoryConfigDirs } from "../../support/config-dirs"
import { createMemoryStore } from "../../support/memory-store"
import { silentLogger } from "../../support/silent-logger"
import { testSupportedModelsWriter } from "../../support/supported-models-writer"

function harness() {
  const store = createMemoryStore()
  const config = createMemoryConfigDirs()
  const service = createAccountsService({
    accounts: store.accounts,
    supportedModels: testSupportedModelsWriter(store.accounts),
    keys: store.keys,
    pools: store.pools,
    cipher: { encrypt: (value) => `sealed:${value}` },
    configDirs: config.dirs,
    ...accountDeletionFixture(config.dirs),
    audit: createAuditRecorder(store.audit, silentLogger()),
    now: () => new Date("2026-11-23T00:00:00.000Z"),
  })
  const add = async (baseUrl?: string, credential: string | null = "sealed:key") =>
    store.accounts.create({
      provider: baseUrl === undefined ? "openrouter" : "openai-compatible",
      label: "a",
      authMaterial: credential,
      baseUrl: baseUrl ?? null,
    })
  return { service, store, add }
}

const MOVED = { ok: false, failure: { status: 400, code: "credential_required_for_new_endpoint" } }

describe("a stored credential stays with the host it was given for", () => {
  test("moving a pinned provider to another host without its key is refused and writes nothing", async () => {
    const h = harness()
    const row = await h.add()
    expect(await h.service.update(row.id, { baseUrl: "https://attacker.test/v1" })).toMatchObject(
      MOVED,
    )
    expect((await h.store.accounts.findById(row.id))?.baseUrl).toBeNull()
  })

  test("so are another port, a downgrade to http, and clearing an override", async () => {
    const h = harness()
    for (const baseUrl of [
      "https://a.test:8443/v1",
      "http://a.test/v1",
      "https://a.test.evil/v1",
    ]) {
      const row = await h.add("https://a.test/v1")
      expect(await h.service.update(row.id, { baseUrl })).toMatchObject(MOVED)
    }
    const moved = await h.store.accounts.create({
      provider: "openrouter",
      label: "o",
      authMaterial: "sealed:key",
      baseUrl: "https://proxy.test/v1",
    })
    expect(await h.service.update(moved.id, { baseUrl: null })).toMatchObject(MOVED)
  })

  test("the key sent with it, a path change, no stored key, and the same value all pass", async () => {
    const h = harness()
    const withKey = await h.add("https://a.test/v1")
    expect(
      await h.service.update(withKey.id, { baseUrl: "https://b.test/v1", credential: "new" }),
    ).toMatchObject({ ok: true, value: { baseUrl: "https://b.test/v1" } })
    expect((await h.store.accounts.findById(withKey.id))?.authMaterial).toBe("sealed:new")

    const path = await h.add("https://a.test/v1")
    expect(await h.service.update(path.id, { baseUrl: "https://a.test/v2" })).toMatchObject({
      ok: true,
    })
    expect(await h.service.update(path.id, { baseUrl: "https://a.test/v2" })).toMatchObject({
      ok: true,
    })

    const keyless = await h.store.accounts.create({
      provider: "ollama",
      label: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
    })
    expect(
      await h.service.update(keyless.id, { baseUrl: "http://10.0.0.2:11434/v1" }),
    ).toMatchObject({
      ok: true,
    })
  })
})

/** The proxy on a plain http endpoint reads the request: whichever of the three moved last. */
describe("a proxied account never reaches plain http with a credential", () => {
  const PLAINTEXT = { ok: false, failure: { code: "egress_proxy_plaintext" } }
  const proxied = async (
    h: ReturnType<typeof harness>,
    baseUrl: string,
    credential: string | null,
  ) => {
    const row = await h.add(baseUrl, credential)
    const held = h.store.rows.accounts.find((account) => account.id === row.id)
    if (held === undefined) throw new Error("fixture missing")
    held.egressProxy = { address: "p.test:1", sealed: "s" }
    return row
  }

  test("moving a proxied account to http is refused even with its key", async () => {
    const h = harness()
    const row = await proxied(h, "https://a.test/v1", "sealed:key")
    expect(
      await h.service.update(row.id, { baseUrl: "http://gw.test/v1", credential: "k" }),
    ).toMatchObject(PLAINTEXT)
  })

  test("so is giving a key to a keyless one already there", async () => {
    const h = harness()
    const row = await proxied(h, "http://a.test/v1", null)
    expect(await h.service.update(row.id, { credential: "k" })).toMatchObject(PLAINTEXT)
  })

  test("an edit that moves none of the three is not judged", async () => {
    const h = harness()
    const row = await proxied(h, "http://a.test/v1", "sealed:key")
    expect(
      await h.service.update(row.id, {
        label: "still editable",
        baseUrl: "http://a.test/v1",
        dialect: null,
      }),
    ).toMatchObject({ ok: true })
  })
})

describe("what an account field may hold", () => {
  const body = { label: "a", provider: "openai-compatible", credential: "k" }
  for (const baseUrl of [
    "https://user:pw@h.test/v1",
    "https://user@h.test/v1",
    "https://h.test/v1?key=sekret",
    "https://h.test/v1#f",
    "ftp://h.test",
    "javascript:alert(1)",
  ]) {
    test(`baseUrl ${baseUrl} is refused on create and update`, () => {
      expect(createAccountBody.safeParse({ ...body, baseUrl }).success).toBe(false)
      expect(updateAccountBody.safeParse({ baseUrl }).success).toBe(false)
    })
  }

  test("http and https endpoints are accepted", () => {
    for (const baseUrl of ["http://127.0.0.1:11434/v1", "https://h.test"])
      expect(createAccountBody.safeParse({ ...body, baseUrl }).success).toBe(true)
  })

  test("a NUL is a 400 here, not a 500 from Postgres", () => {
    for (const patch of [
      { label: "a\0b" },
      { modelAliases: { "a\0": "b" } },
      { modelAliases: { a: "b\0" } },
      { supportedModels: ["m\0"] },
    ])
      expect(updateAccountBody.safeParse(patch).success).toBe(false)
    expect(testNowBody.safeParse({ model: "m\0" }).success).toBe(false)
  })
})

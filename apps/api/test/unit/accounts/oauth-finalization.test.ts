import { expect, test } from "bun:test"
import { createOAuthConnectService } from "../../../src/services/accounts"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { createMemoryStore } from "../../support/memory-store"
import { deferred, tokenResponse } from "./refresh-fixtures"

const NOW = new Date("2026-10-03T00:00:00Z")
const identity = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "identity" } })).toString("base64url")}.sig`
async function setup(overrides: {
  audit?: { record: () => Promise<void> }
  fetch?: (request: Request) => Promise<Response>
  refreshCatalogAfterMutation?: () => Promise<void>
  onCredentialWritten?: (id: string) => Promise<void>
  exchangeTimeoutMs?: number
}) {
  const store = createMemoryStore()
  const row = await store.accounts.create({ label: "finalization", provider: "openai-oauth" })
  const connect = createOAuthConnectService({
    accounts: store.accounts,
    states: store.oauthStates,
    cipher: createCredentialCipher({ key: new Uint8Array(32).fill(1) }),
    audit: { record: async () => {} },
    fetch: async () => tokenResponse({ access_token: "opaque", id_token: identity }),
    refreshCatalogAfterMutation: async () => {},
    exchangeTimeoutMs: 20,
    now: () => NOW,
    stateMinutes: 10,
    ...overrides,
  })
  const begin = await connect.begin(row.id, "connect")
  if (!begin.ok) throw new Error("begin failed")
  const state = new URL(begin.value.authorizeUrl).searchParams.get("state")
  return { store, row, complete: () => connect.complete(row.id, `code#${state}`) }
}

test("saved authorization installs the catalog before a deferred audit and always schedules", async () => {
  const entered = deferred<void>()
  const release = deferred<void>()
  let coherent = false
  let scheduled = false
  const h = await setup({
    audit: {
      record: async () => {
        entered.resolve()
        await release.promise
      },
    },
    refreshCatalogAfterMutation: async () => {
      coherent = true
    },
    onCredentialWritten: async () => {
      scheduled = true
    },
  })
  const completion = h.complete()
  await entered.promise
  expect(coherent).toBe(true)
  expect((await h.store.accounts.findById(h.row.id))?.authMaterial).not.toBeNull()
  release.resolve()
  expect((await completion).ok).toBe(true)
  expect(scheduled).toBe(true)
})

test("throwing authorization audit still installs catalog and schedules committed tokens", async () => {
  let coherent = false
  let scheduled = false
  const h = await setup({
    audit: {
      record: async () => {
        throw new Error("audit down")
      },
    },
    refreshCatalogAfterMutation: async () => {
      coherent = true
    },
    onCredentialWritten: async () => {
      scheduled = true
    },
  })
  expect(await h.complete()).toMatchObject({ ok: false, failure: { code: "routing_unavailable" } })
  expect(coherent).toBe(true)
  expect(scheduled).toBe(true)
})

test("code exchange deadline bounds a transport ignoring Request.signal", async () => {
  const h = await setup({ fetch: () => new Promise(() => {}) })
  expect(await h.complete()).toMatchObject({ ok: false, failure: { code: "exchange_unreachable" } })
  expect((await h.store.accounts.findById(h.row.id))?.authMaterial).toBeNull()
})

test("code exchange deadline cancels a stalled response body", async () => {
  let cancelled = false
  const h = await setup({
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"access_token":'))
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
  })
  expect(await h.complete()).toMatchObject({ ok: false, failure: { code: "exchange_unreachable" } })
  expect(cancelled).toBe(true)
  expect((await h.store.accounts.findById(h.row.id))?.authMaterial).toBeNull()
})

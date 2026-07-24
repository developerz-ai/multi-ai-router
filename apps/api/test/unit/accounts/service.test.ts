import { describe, expect, test } from "bun:test"
import {
  type AccountsService,
  createAccountBody,
  createAccountsService,
  updateAccountBody,
} from "../../../src/services/accounts"
import { createAuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { createMemoryStore, type MemoryStore } from "../../support/memory-store"

/**
 * The accounts service, with in-memory stores and a real cipher.
 *
 * The assertions that matter most are negative ones: the plaintext credential
 * and its ciphertext must not appear in any value this service hands back, nor
 * in any audit row it writes (CLAUDE.md non-negotiable 3).
 */

const SECRET = "sk-live-super-secret-upstream-key"
const NOW = new Date("2026-07-24T12:00:00.000Z")

function harness(): { service: AccountsService; store: MemoryStore } {
  const store = createMemoryStore()
  const service = createAccountsService({
    accounts: store.accounts,
    keys: store.keys,
    cipher: createCredentialCipher({ key: new Uint8Array(32).fill(7) }),
    audit: createAuditRecorder(store.audit),
    now: () => NOW,
  })
  return { service, store }
}

async function created(service: AccountsService) {
  const result = await service.create({
    label: "openrouter-primary",
    provider: "openrouter",
    credential: SECRET,
  })
  if (!result.ok) throw new Error(`create failed: ${result.failure.message}`)
  return result.value
}

describe("create", () => {
  test("encrypts the credential and returns only the fact that one exists", async () => {
    const { service, store } = harness()
    const view = await created(service)

    expect(view.hasCredential).toBe(true)
    expect(JSON.stringify(view)).not.toContain(SECRET)
    // Stored as an envelope, not as the value the operator typed.
    expect(store.rows.accounts[0]?.authMaterial).toStartWith("v1.k1.")
    expect(store.rows.accounts[0]?.authMaterial).not.toContain(SECRET)
  })

  test("no response from any read path carries the credential or its ciphertext", async () => {
    const { service, store } = harness()
    const view = await created(service)
    const envelope = store.rows.accounts[0]?.authMaterial ?? ""

    const responses = [
      view,
      await service.get(view.id),
      await service.list({}),
      await service.disable(view.id),
      await service.update(view.id, { label: "renamed" }),
    ]

    for (const response of responses) {
      const rendered = JSON.stringify(response)
      expect(rendered).not.toContain(SECRET)
      expect(rendered).not.toContain(envelope)
      expect(rendered).not.toContain("authMaterial")
    }
  })

  test("the shape rules run before anything is written", async () => {
    const { service, store } = harness()
    const result = await service.create({
      label: "vllm",
      provider: "openai-compatible",
      credential: SECRET,
    })

    expect(result.ok).toBe(false)
    expect(store.rows.accounts).toHaveLength(0)
    expect(store.rows.audit).toHaveLength(0)
  })
})

describe("audit", () => {
  test("every mutation appends one event and none of them carries key material", async () => {
    const { service, store } = harness()
    const view = await created(service)
    await service.update(view.id, { credential: "sk-rotated-secret-value", label: "renamed" })
    await service.disable(view.id)

    expect(store.rows.audit.map((row) => row.kind)).toEqual([
      "account.created",
      "account.updated",
      "account.disabled",
    ])

    const rendered = JSON.stringify(store.rows.audit)
    expect(rendered).not.toContain(SECRET)
    expect(rendered).not.toContain("sk-rotated-secret-value")
    expect(rendered).not.toContain("v1.k1.")
    // The rotation is recorded as a field name, which is the point of the event.
    expect(store.rows.audit[1]?.detail).toMatchObject({ fields: ["credential", "label"] })
  })

  test("audit rows carry the subject so history outlives the row", async () => {
    const { service, store } = harness()
    const view = await created(service)
    expect(store.rows.audit[0]).toMatchObject({ subjectType: "account", subjectId: view.id })
  })
})

describe("delete", () => {
  test("refuses while a key's scope names the account, and says which key", async () => {
    const { service, store } = harness()
    const view = await created(service)
    const key = await store.keys.create({
      name: "ci-agent-3",
      value: "v1.k1.x",
      prefix: "mar_live_",
    })
    await store.keys.replaceScopeTargets(key.id, { accountIds: [view.id] })

    const result = await service.remove(view.id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure.status).toBe(409)
      expect(result.failure.message).toContain("ci-agent-3")
    }
    expect(store.rows.accounts).toHaveLength(1)
  })

  test("removes an unreferenced account and audits it", async () => {
    const { service, store } = harness()
    const view = await created(service)

    const result = await service.remove(view.id)
    expect(result.ok).toBe(true)
    expect(store.rows.accounts).toHaveLength(0)
    expect(store.rows.audit.at(-1)?.kind).toBe("account.deleted")
  })

  test("an unknown id is a 404, not a silent success", async () => {
    const { service } = harness()
    const result = await service.remove("11111111-1111-4111-8111-111111111111")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.status).toBe(404)
  })
})

describe("write schemas", () => {
  test("reject an unknown field rather than ignoring it", () => {
    const parsed = createAccountBody.safeParse({
      label: "x",
      provider: "openrouter",
      credential: SECRET,
      authMaterial: "v1.k1.injected",
    })
    expect(parsed.success).toBe(false)
  })

  test("reject a provider that is not in the registry", () => {
    expect(createAccountBody.safeParse({ label: "x", provider: "hotdog" }).success).toBe(false)
  })

  test("reject an empty label and a non-URL base URL", () => {
    expect(createAccountBody.safeParse({ label: "  ", provider: "openrouter" }).success).toBe(false)
    expect(
      createAccountBody.safeParse({ label: "x", provider: "openrouter", baseUrl: "not-a-url" })
        .success,
    ).toBe(false)
  })

  test("reject an empty update, and a status only the router may assert", () => {
    expect(updateAccountBody.safeParse({}).success).toBe(false)
    expect(updateAccountBody.safeParse({ status: "exhausted" }).success).toBe(false)
    expect(updateAccountBody.safeParse({ status: "disabled" }).success).toBe(true)
  })
})

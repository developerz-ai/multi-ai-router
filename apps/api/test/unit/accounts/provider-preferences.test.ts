import { describe, expect, test } from "bun:test"
import {
  createAccountBody,
  createAccountsService,
  describeProvider,
  updateAccountBody,
} from "../../../src/services/accounts"
import { createAuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { accountDeletionFixture } from "../../support/account-deletion"
import { createMemoryConfigDirs } from "../../support/config-dirs"
import { createMemoryStore } from "../../support/memory-store"
import { silentLogger } from "../../support/silent-logger"
import { testSupportedModelsWriter } from "../../support/supported-models-writer"

/**
 * `providerPreferences` at the admin write: invalid is a `400` there, never a value stored and
 * quietly not sent, and only an account whose surface reads a `provider` object may hold one.
 */

const NOW = new Date("2026-11-14T12:00:00.000Z")
const CODING = { sort: "price", quantizations: ["fp8", "bf16"], allow_fallbacks: true } as const

function harness() {
  const store = createMemoryStore()
  const configDirs = createMemoryConfigDirs()
  const service = createAccountsService({
    accounts: store.accounts,
    supportedModels: testSupportedModelsWriter(store.accounts),
    keys: store.keys,
    pools: store.pools,
    cipher: createCredentialCipher({ key: new Uint8Array(32).fill(7) }),
    configDirs: configDirs.dirs,
    ...accountDeletionFixture(configDirs.dirs),
    audit: createAuditRecorder(store.audit, silentLogger()),
    now: () => NOW,
  })
  return { service, store }
}

const parseCreate = (body: unknown) => {
  const parsed = createAccountBody.safeParse(body)
  if (!parsed.success) throw new Error(parsed.error.message)
  return parsed.data
}
const parseUpdate = (body: unknown) => {
  const parsed = updateAccountBody.safeParse(body)
  if (!parsed.success) throw new Error(parsed.error.message)
  return parsed.data
}

describe("providerPreferences on an account, refusals first", () => {
  test("an invalid preference is refused by the write contract", () => {
    for (const providerPreferences of [
      { sort: "cheapest" },
      { quantizations: ["fp7"] },
      { allowFallbacks: true },
      {},
    ]) {
      expect(updateAccountBody.safeParse({ providerPreferences }).success).toBe(false)
    }
  })

  test("a provider whose surface reads no provider field is refused them, on create", async () => {
    const { service, store } = harness()
    const result = await service.create(
      parseCreate({
        label: "ds",
        provider: "deepseek",
        credential: "sk-ds",
        providerPreferences: CODING,
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure.code).toBe("provider_preferences_unsupported")
    expect(store.rows.accounts).toHaveLength(0)
  })

  test("and on update, while null still clears on any provider", async () => {
    const { service } = harness()
    const made = await service.create(
      parseCreate({ label: "ds", provider: "deepseek", credential: "sk-ds" }),
    )
    if (!made.ok) throw new Error(made.failure.message)
    const refused = await service.update(
      made.value.id,
      parseUpdate({ providerPreferences: CODING }),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.failure.code).toBe("provider_preferences_unsupported")
    expect(
      (await service.update(made.value.id, parseUpdate({ providerPreferences: null }))).ok,
    ).toBe(true)
  })

  test("an openrouter account stores, shows and clears them", async () => {
    const { service, store } = harness()
    const made = await service.create(
      parseCreate({ label: "or", provider: "openrouter", credential: "sk-or" }),
    )
    if (!made.ok) throw new Error(made.failure.message)
    expect(made.value.providerPreferences).toBeNull()

    const set = await service.update(made.value.id, parseUpdate({ providerPreferences: CODING }))
    expect<unknown>(set.ok && set.value.providerPreferences).toEqual(CODING)
    expect<unknown>(store.rows.accounts[0]?.providerPreferences).toEqual(CODING)

    const cleared = await service.update(made.value.id, parseUpdate({ providerPreferences: null }))
    expect(cleared.ok && cleared.value.providerPreferences).toBeNull()
  })

  test("the provider descriptor says which providers take them, so the console can", () => {
    expect(describeProvider("openrouter").providerPreferences).toBe(true)
    expect(describeProvider("deepseek").providerPreferences).toBe(false)
    expect(describeProvider("anthropic-oauth").providerPreferences).toBe(false)
  })
})

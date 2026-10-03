import { expect, test } from "bun:test"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"
import { createTestNowService } from "../../../src/services/accounts/test-now"
import { createMemoryStore } from "../../support/memory-store"

for (const mode of ["background", "interactive"] as const) {
  test(`${mode} test preserves explicit caller semantics and guards only background starts`, async () => {
    const store = createMemoryStore()
    const account = await store.accounts.create(
      { provider: "openrouter", label: "fixture", authMaterial: "cipher" },
      new Date(),
    )
    let guards = 0,
      fetches = 0,
      audits = 0
    const service = createTestNowService({
      accounts: store.accounts,
      cipher: { decrypt: () => "fixture-key" },
      cooldownSeconds: 30,
      timeoutMs: 1000,
      now: () => new Date(0),
      audit: {
        record: async () => {
          audits++
        },
      },
      createBackgroundStartGuard: (expected) => async () => {
        expect(expected.lifecycleVersion).toBe(account.lifecycleVersion)
        if (++guards === 2) throw new UpstreamAdmissionRefused()
      },
      fetch: async () => {
        fetches++
        return new Response("{}")
      },
    })
    const result = await service.test(account.id, {
      model: "fixture-model",
      ...(mode === "background" ? { backgroundExpectedAccount: account } : {}),
    })
    if (mode === "background") {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.failure.code).toBe("background_admission_refused")
      expect(fetches).toBe(0)
      expect(audits).toBe(0)
      expect(guards).toBe(2)
      expect(service.lastCheckedAt(account.id)).toBeNull()
    } else {
      expect(result.ok).toBe(true)
      expect(fetches).toBe(1)
      expect(audits).toBe(1)
      expect(guards).toBe(0)
    }
  })
}

test("unconfigured background admission fails closed before taking the local cooldown", async () => {
  const store = createMemoryStore()
  const account = await store.accounts.create(
    { provider: "openrouter", label: "fixture" },
    new Date(),
  )
  const service = createTestNowService({
    accounts: store.accounts,
    cipher: { decrypt: () => "key" },
    cooldownSeconds: 30,
    timeoutMs: 1000,
    now: () => new Date(),
    audit: { record: async () => {} },
    fetch: async () => {
      throw new Error("must not fetch")
    },
  })
  const result = await service.test(account.id, {
    model: "model",
    backgroundExpectedAccount: account,
  })
  expect(result.ok).toBe(false)
  expect(service.lastCheckedAt(account.id)).toBeNull()
})

test("background subject freezes before the first asynchronous account reread", async () => {
  const store = createMemoryStore()
  const account = await store.accounts.create(
    { provider: "openrouter", label: "fixture" },
    new Date(),
  )
  const originalVersion = account.lifecycleVersion
  let observedVersion = -1
  const service = createTestNowService({
    accounts: store.accounts,
    cipher: { decrypt: () => "key" },
    cooldownSeconds: 30,
    timeoutMs: 1000,
    now: () => new Date(),
    audit: { record: async () => {} },
    createBackgroundStartGuard: (expected) => async () => {
      observedVersion = expected.lifecycleVersion
      throw new UpstreamAdmissionRefused()
    },
  })
  const result = service.test(account.id, { model: "model", backgroundExpectedAccount: account })
  account.lifecycleVersion++
  await result
  expect(observedVersion).toBe(originalVersion)
})

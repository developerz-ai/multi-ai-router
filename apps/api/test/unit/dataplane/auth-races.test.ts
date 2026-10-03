import { expect, test } from "bun:test"
import { KeyRevokedError } from "@multi-ai-router/core"
import { createRouterKeyVerifier, unscopedLoader } from "../../../src/services/dataplane"
import { apiKeyRow, cipher, NOW, newRouterKey } from "./fixtures"

function deferred() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

for (const invalidateAll of [false, true]) {
  test(`invalidation fences a pending scope load (all=${invalidateAll})`, async () => {
    const key = newRouterKey()
    const row = apiKeyRow(key, cipher())
    const gate = deferred()
    const entered = deferred()
    let revoked = false
    const verifier = createRouterKeyVerifier({
      repository: { findUsableByPrefix: async () => (revoked ? [] : [row]) },
      cipher: cipher(),
      now: () => NOW,
      loadScope: async (value) => {
        entered.release()
        await gate.promise
        return unscopedLoader(value)
      },
    })
    const result = verifier.verify(key).catch((error: unknown) => error)
    await entered.promise
    revoked = true
    if (invalidateAll) verifier.invalidateAll()
    else verifier.invalidate(row.id)
    gate.release()
    expect(await result).toBeInstanceOf(KeyRevokedError)
    await expect(verifier.verify(key)).rejects.toBeInstanceOf(KeyRevokedError)
  })
}

test("concurrent identical cache misses share one bounded lookup", async () => {
  const key = newRouterKey()
  const gate = deferred()
  let calls = 0
  const verifier = createRouterKeyVerifier({
    repository: {
      findUsableByPrefix: async () => {
        calls++
        await gate.promise
        return [apiKeyRow(key, cipher())]
      },
    },
    cipher: cipher(),
    loadScope: unscopedLoader,
    now: () => NOW,
    cache: { maxEntries: 1 },
  })
  const pending = Array.from({ length: 10 }, () => verifier.verify(key))
  expect(calls).toBe(1)
  await expect(verifier.verify(newRouterKey())).rejects.toBeInstanceOf(KeyRevokedError)
  expect(calls).toBe(1)
  gate.release()
  expect(await Promise.all(pending)).toHaveLength(10)
})

test("a key expiring during its scope load is refused", async () => {
  const key = newRouterKey()
  let at = NOW.getTime()
  const verifier = createRouterKeyVerifier({
    repository: {
      findUsableByPrefix: async () => [apiKeyRow(key, cipher(), { expiresAt: new Date(at + 1) })],
    },
    cipher: cipher(),
    now: () => new Date(at),
    loadScope: async (row) => {
      at += 2
      return unscopedLoader(row)
    },
  })
  await expect(verifier.verify(key)).rejects.toBeInstanceOf(KeyRevokedError)
})

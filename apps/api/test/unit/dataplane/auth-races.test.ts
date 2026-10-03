import { expect, test } from "bun:test"
import { KeyRevokedError, KeyVerificationUnavailableError } from "@multi-ai-router/core"
import { createRouterKeyVerifier, unscopedLoader } from "../../../src/services/dataplane"
import { apiKeyRow, cipher, NOW, newRouterKey } from "./fixtures"

function deferred() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

for (const phase of ["repository", "scope"]) {
  for (const invalidateAll of [false, true]) {
    test(`invalidation fences a pending ${phase} load (all=${invalidateAll})`, async () => {
      const key = newRouterKey()
      const row = apiKeyRow(key, cipher())
      const gate = deferred()
      const entered = deferred()
      let revoked = false
      const verifier = createRouterKeyVerifier({
        repository: {
          findUsableByPrefix: async () => {
            const rows = revoked ? [] : [row]
            if (phase === "repository") {
              entered.release()
              await gate.promise
            }
            return rows
          },
        },
        cipher: cipher(),
        now: () => NOW,
        loadScope: async (value) => {
          if (phase === "scope") {
            entered.release()
            await gate.promise
          }
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
}

for (const phase of ["repository", "scope"]) {
  test(`an unrelated invalidation reloads a pending ${phase} once for all waiters`, async () => {
    const key = newRouterKey()
    const row = apiKeyRow(key, cipher())
    const gate = deferred()
    const entered = deferred()
    let calls = 0
    let verified = 0
    const verifier = createRouterKeyVerifier({
      repository: {
        findUsableByPrefix: async () => {
          calls++
          if (phase === "repository") {
            entered.release()
            await gate.promise
          }
          return [row]
        },
      },
      cipher: cipher(),
      now: () => NOW,
      loadScope: async (value) => {
        if (phase === "scope") {
          entered.release()
          await gate.promise
        }
        return unscopedLoader(value)
      },
      onVerified: () => verified++,
      cache: { maxEntries: 1 },
    })
    const pending = Array.from({ length: 10 }, () => verifier.verify(key))
    await entered.promise
    verifier.invalidate("another-key")
    gate.release()
    const results = await Promise.all(pending)
    expect(results.every((result) => result.id === row.id)).toBe(true)
    expect(calls).toBe(2)
    expect(verified).toBe(1)
    expect((await verifier.verify(key)).id).toBe(row.id)
    expect(calls).toBe(2)
  })

  test(`continuous invalidation during ${phase} is bounded and retryable`, async () => {
    const key = newRouterKey()
    const row = apiKeyRow(key, cipher())
    let calls = 0
    let churning = true
    let invalidate = () => {}
    const verifier = createRouterKeyVerifier({
      repository: {
        findUsableByPrefix: async () => {
          calls++
          if (phase === "repository" && churning) invalidate()
          return [row]
        },
      },
      cipher: cipher(),
      now: () => NOW,
      loadScope: async (value) => {
        if (phase === "scope" && churning) invalidate()
        return unscopedLoader(value)
      },
      cache: { maxEntries: 1 },
    })
    invalidate = () => verifier.invalidate("another-key")
    const results = await Promise.all(
      Array.from({ length: 10 }, () => verifier.verify(key).catch((error: unknown) => error)),
    )
    expect(results.every((result) => result instanceof KeyVerificationUnavailableError)).toBe(true)
    expect(results[0]).toMatchObject({ status: 503, retryAfterSeconds: 1 })
    expect(calls).toBe(3)
    churning = false
    expect((await verifier.verify(key)).id).toBe(row.id)
    expect(calls).toBe(4)
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
  const overloaded = await verifier.verify(newRouterKey()).catch((error: unknown) => error)
  expect(overloaded).toBeInstanceOf(KeyVerificationUnavailableError)
  expect(overloaded).toMatchObject({ status: 503, retryAfterSeconds: 1 })
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

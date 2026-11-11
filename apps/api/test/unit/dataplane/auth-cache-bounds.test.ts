import { describe, expect, test } from "bun:test"
import { KeyRevokedError, KeyVerificationUnavailableError } from "@multi-ai-router/core"
import type { ApiKeyRow } from "@multi-ai-router/db"
import { createRouterKeyVerifier, unscopedLoader } from "../../../src/services/dataplane"
import { repositoryCandidateLoader } from "../../../src/services/dataplane/auth/scope"
import { apiKeyRow, cipher, clock, keyRepository, newRouterKey } from "./fixtures"

/**
 * The verifier's bounds under hostile or failing conditions: an unknown-key spray (01.1), a key
 * whose cache entry ages (01.8), and a store that stops answering (12.3, prod 2026-10-31).
 */

const TTL_MS = 60_000

function subject(
  rows: ApiKeyRow[],
  cache: Parameters<typeof createRouterKeyVerifier>[0]["cache"] = {},
  testClock = clock(),
) {
  const repository = keyRepository(rows)
  let failing: Error | null = null
  let hold: Promise<void> | null = null
  const wrapped = {
    async findUsableByPrefix(prefix: string, now: Date) {
      if (hold !== null) await hold
      if (failing !== null) throw failing
      return repository.findUsableByPrefix(prefix, now)
    },
  }
  return {
    repository,
    clock: testClock,
    failWith: (error: Error | null) => {
      failing = error
    },
    holdLoads: (gate: Promise<void> | null) => {
      hold = gate
    },
    verifier: createRouterKeyVerifier({
      repository: wrapped,
      loadScope: unscopedLoader,
      cipher: cipher(),
      now: testClock.now,
      cache: { ttlMs: TTL_MS, ...cache },
    }),
  }
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe("an unknown-key spray (01.1)", () => {
  test("cannot evict a verified key: the warm key verifies with no further query", async () => {
    const key = newRouterKey()
    const s = subject([apiKeyRow(key, cipher())], { maxEntries: 64, negativeMaxEntries: 64 })
    await s.verifier.verify(key)
    for (let i = 0; i < 200; i++) {
      await expect(s.verifier.verify(newRouterKey())).rejects.toThrow(KeyRevokedError)
    }
    const queries = s.repository.queries
    await s.verifier.verify(key)
    expect(s.repository.queries).toBe(queries)
  })

  test("pending misses past the ceiling are refused 503 while a cached key still verifies", async () => {
    const key = newRouterKey()
    const s = subject([apiKeyRow(key, cipher())], { maxPendingLoads: 2 })
    await s.verifier.verify(key)
    let release: () => void = () => undefined
    s.holdLoads(new Promise<void>((resolve) => (release = resolve)))
    const first = s.verifier.verify(newRouterKey())
    const second = s.verifier.verify(newRouterKey())
    await expect(s.verifier.verify(newRouterKey())).rejects.toThrow(KeyVerificationUnavailableError)
    expect((await s.verifier.verify(key)).id).toBe("11111111-1111-4111-8111-111111111111")
    release()
    const outcomes = await Promise.allSettled([first, second])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"])
  })

  test("a zero negative TTL caches no refusal at all", async () => {
    const bad = newRouterKey()
    const s = subject([], { negativeTtlMs: 0 })
    await expect(s.verifier.verify(bad)).rejects.toThrow(KeyRevokedError)
    await expect(s.verifier.verify(bad)).rejects.toThrow(KeyRevokedError)
    expect(s.repository.queries).toBe(2)
  })
})

describe("refresh-ahead (01.8)", () => {
  test("a hit past the refresh point answers from memory and starts exactly one reload", async () => {
    const key = newRouterKey()
    const s = subject([apiKeyRow(key, cipher())])
    await s.verifier.verify(key)
    s.clock.advance(TTL_MS * 0.9)
    let release: () => void = () => undefined
    s.holdLoads(new Promise<void>((resolve) => (release = resolve)))
    await s.verifier.verify(key)
    await s.verifier.verify(key)
    release()
    await settle()
    expect(s.repository.queries).toBe(2)
    // The reload landed: the entry is fresh again, so no query at the old TTL.
    s.clock.advance(TTL_MS * 0.2)
    await s.verifier.verify(key)
    expect(s.repository.queries).toBe(2)
  })

  test("a revoke during the background reload is not re-cached", async () => {
    const key = newRouterKey()
    const row = apiKeyRow(key, cipher())
    const s = subject([row])
    await s.verifier.verify(key)
    s.clock.advance(TTL_MS * 0.9)
    let release: () => void = () => undefined
    s.holdLoads(new Promise<void>((resolve) => (release = resolve)))
    await s.verifier.verify(key)
    s.repository.rows = [{ ...row, revoked: true }]
    s.verifier.invalidate(row.id)
    release()
    await settle()
    s.holdLoads(null)
    await expect(s.verifier.verify(key)).rejects.toThrow(KeyRevokedError)
  })
})

describe("a store failure (12.3)", () => {
  test("serves the last verified key past its TTL, inside the stale window", async () => {
    const key = newRouterKey()
    const s = subject([apiKeyRow(key, cipher())], { staleOnErrorMs: 300_000 })
    await s.verifier.verify(key)
    s.clock.advance(TTL_MS + 1_000)
    s.failWith(new Error("getaddrinfo ENOTFOUND pg-production-0"))
    expect((await s.verifier.verify(key)).name).toBeDefined()
  })

  test("stops serving it once the stale window closes — typed 503, never a generic error", async () => {
    const key = newRouterKey()
    const s = subject([apiKeyRow(key, cipher())], { staleOnErrorMs: 300_000 })
    await s.verifier.verify(key)
    s.clock.advance(TTL_MS + 300_001)
    s.failWith(new Error("getaddrinfo ENOTFOUND pg-production-0"))
    const refused = await s.verifier.verify(key).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(KeyVerificationUnavailableError)
    expect((refused as KeyVerificationUnavailableError).retryAfterSeconds).toBe(1)
  })

  test("an unknown key with the store down is a typed 503", async () => {
    const s = subject([])
    s.failWith(new Error("Failed query: select … from api_keys where prefix = $1"))
    await expect(s.verifier.verify(newRouterKey())).rejects.toThrow(KeyVerificationUnavailableError)
  })

  test("a key the store says is gone is refused even inside the stale window", async () => {
    const key = newRouterKey()
    const row = apiKeyRow(key, cipher())
    const s = subject([row], { staleOnErrorMs: 300_000 })
    await s.verifier.verify(key)
    s.repository.rows = []
    s.clock.advance(TTL_MS + 1_000)
    await expect(s.verifier.verify(key)).rejects.toThrow(KeyRevokedError)
  })
})

test("the combined loader resolves a scoped key from one statement", async () => {
  const key = newRouterKey()
  const row = apiKeyRow(key, cipher(), { scope: "pools" })
  let statements = 0
  const verifier = createRouterKeyVerifier({
    loadCandidates: repositoryCandidateLoader({
      findUsableWithTargetsByPrefix: async () => {
        statements++
        return [{ key: row, poolIds: ["pool-b", "pool-a"], accountIds: [] }]
      },
    }),
    cipher: cipher(),
    now: clock().now,
  })
  expect((await verifier.verify(key)).scope).toEqual({
    kind: "pools",
    poolIds: ["pool-b", "pool-a"],
  })
  expect(statements).toBe(1)
})

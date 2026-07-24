import { describe, expect, test } from "bun:test"
import { KeyRevokedError } from "@multi-ai-router/core"
import {
  createRouterKeyVerifier,
  keyScopeSnapshot,
  presentedRouterKey,
  unscopedLoader,
} from "../../../src/services/dataplane"
import { apiKeyRow, cipher, clock, keyRepository, NOW, newRouterKey } from "./fixtures"

/**
 * Router key verification: both header forms, the constant-time compare behind the prefix index,
 * and the in-memory cache the performance budget requires.
 */

describe("presented key", () => {
  test("is read from the OpenAI bearer form", () => {
    expect(presentedRouterKey("Bearer mar_live_abc", undefined)).toBe("mar_live_abc")
  })

  test("is read from the Anthropic x-api-key form", () => {
    expect(presentedRouterKey(undefined, "mar_live_abc")).toBe("mar_live_abc")
  })

  test("accepts the same key in both headers — one key works for either dialect", () => {
    expect(presentedRouterKey("Bearer mar_live_abc", "mar_live_abc")).toBe("mar_live_abc")
  })

  test("rejects two headers carrying different keys rather than preferring one", () => {
    expect(() => presentedRouterKey("Bearer mar_live_a", "mar_live_b")).toThrow(KeyRevokedError)
  })

  test("rejects a request with no key at all", () => {
    expect(() => presentedRouterKey(undefined, undefined)).toThrow(KeyRevokedError)
  })

  test("ignores a non-bearer Authorization scheme", () => {
    expect(() => presentedRouterKey("Basic abc", undefined)).toThrow(KeyRevokedError)
  })
})

describe("scope snapshot", () => {
  test("`all` skips pools entirely", () => {
    expect(keyScopeSnapshot("all", { poolIds: ["p"], accountIds: ["a"] })).toEqual({ kind: "all" })
  })

  test("`pools` and `accounts` carry only their own targets", () => {
    const targets = { poolIds: ["p1"], accountIds: ["a1"] }
    expect(keyScopeSnapshot("pools", targets)).toEqual({ kind: "pools", poolIds: ["p1"] })
    expect(keyScopeSnapshot("accounts", targets)).toEqual({
      kind: "accounts",
      accountIds: ["a1"],
    })
  })

  test("a limited scope with unloadable targets fails closed, never widening to `all`", async () => {
    const cryptor = cipher()
    const key = newRouterKey()
    const scope = await unscopedLoader(apiKeyRow(key, cryptor, { scope: "pools" }))
    expect(scope).toEqual({ kind: "pools", poolIds: [] })
  })
})

function verifier(rows: ReturnType<typeof apiKeyRow>[], test_clock = clock()) {
  const repository = keyRepository(rows)
  return {
    repository,
    clock: test_clock,
    subject: createRouterKeyVerifier({
      repository,
      cipher: cipher(),
      loadScope: unscopedLoader,
      now: test_clock.now,
    }),
  }
}

describe("router key verification", () => {
  test("verifies a stored key and resolves its scope", async () => {
    const key = newRouterKey()
    const { subject } = verifier([apiKeyRow(key, cipher())])

    const verified = await subject.verify(key)

    expect(verified.id).toBe("11111111-1111-4111-8111-111111111111")
    expect(verified.scope).toEqual({ kind: "all" })
  })

  test("rejects an unknown key", async () => {
    const { subject } = verifier([apiKeyRow(newRouterKey(), cipher())])
    await expect(subject.verify(newRouterKey())).rejects.toThrow(KeyRevokedError)
  })

  test("rejects a revoked key — the row is excluded by the lookup itself", async () => {
    const key = newRouterKey()
    const { subject } = verifier([apiKeyRow(key, cipher(), { revoked: true, revokedAt: NOW })])
    await expect(subject.verify(key)).rejects.toThrow(KeyRevokedError)
  })

  test("rejects an expired key exactly like a revoked one", async () => {
    const key = newRouterKey()
    const expiresAt = new Date(NOW.getTime() - 1_000)
    const { subject } = verifier([apiKeyRow(key, cipher(), { expiresAt })])
    await expect(subject.verify(key)).rejects.toThrow(KeyRevokedError)
  })

  test("rejects a malformed value without ever querying", async () => {
    const { subject, repository } = verifier([])
    await expect(subject.verify("not-a-router-key")).rejects.toThrow(KeyRevokedError)
    expect(repository.queries).toBe(0)
  })

  test("a key whose prefix collides is separated by the compare, not by the index", async () => {
    const cryptor = cipher()
    const key = newRouterKey()
    const impostor = `${key.slice(0, 17)}${"Z".repeat(24)}`
    const rows = [
      apiKeyRow(impostor, cryptor, { id: "22222222-2222-4222-8222-222222222222" }),
      apiKeyRow(key, cryptor),
    ]
    // Both rows share a prefix, so the lookup returns both and the compare decides.
    rows[0] = { ...rows[0], prefix: rows[1]?.prefix ?? "" } as (typeof rows)[number]

    const { subject } = verifier(rows)
    const verified = await subject.verify(key)
    expect(verified.id).toBe("11111111-1111-4111-8111-111111111111")
  })

  test("caches a verified key: the second request costs no query", async () => {
    const key = newRouterKey()
    const { subject, repository } = verifier([apiKeyRow(key, cipher())])

    await subject.verify(key)
    await subject.verify(key)

    expect(repository.queries).toBe(1)
  })

  test("caches a refusal too, so a bad key cannot become a query generator", async () => {
    const bad = newRouterKey()
    const { subject, repository } = verifier([apiKeyRow(newRouterKey(), cipher())])

    await expect(subject.verify(bad)).rejects.toThrow(KeyRevokedError)
    await expect(subject.verify(bad)).rejects.toThrow(KeyRevokedError)

    expect(repository.queries).toBe(1)
  })

  test("invalidate makes a revocation effective before the TTL expires", async () => {
    const key = newRouterKey()
    const row = apiKeyRow(key, cipher())
    const { subject, repository } = verifier([row])

    await subject.verify(key)
    repository.rows = [{ ...row, revoked: true }]
    subject.invalidate(row.id)

    await expect(subject.verify(key)).rejects.toThrow(KeyRevokedError)
  })

  test("a cached key that passes its expiry stops verifying without a new query", async () => {
    const key = newRouterKey()
    const expiresAt = new Date(NOW.getTime() + 30_000)
    const testClock = clock()
    const { subject } = verifier([apiKeyRow(key, cipher(), { expiresAt })], testClock)

    await subject.verify(key)
    testClock.advance(31_000)

    await expect(subject.verify(key)).rejects.toThrow(KeyRevokedError)
  })

  test("re-queries once the cache TTL lapses", async () => {
    const key = newRouterKey()
    const testClock = clock()
    const { subject, repository } = verifier([apiKeyRow(key, cipher())], testClock)

    await subject.verify(key)
    testClock.advance(61_000)
    await subject.verify(key)

    expect(repository.queries).toBe(2)
  })
})

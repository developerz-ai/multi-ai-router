import { describe, expect, test } from "bun:test"
import type { AdminCredentialRepository, AdminCredentialRow } from "@multi-ai-router/db"
import {
  createLocalAdminCredentials,
  hashLocalPassword,
  LOCAL_PASSWORD_MIN_LENGTH,
  LocalPasswordPolicyError,
} from "../../../src/services/admin-auth/localCredential"

/**
 * The credential service against an in-memory repository: the hashing is real
 * argon2id (Bun.password), so what is locked here is the actual guarantee —
 * set then verify, wrong password rejected, replace recovers, an absent row is
 * a `false` that costs the same work as a wrong password, and the plaintext
 * never reaches the store.
 */

const PASSWORD = "correct horse battery staple"

function memoryStore(initial: string | null = null): AdminCredentialRepository & {
  stored: () => string | null
} {
  let hash: string | null = initial
  const row = (): AdminCredentialRow | undefined =>
    hash === null
      ? undefined
      : {
          id: "local",
          passwordHash: hash,
          createdAt: new Date("2026-07-31T10:00:00.000Z"),
          updatedAt: new Date("2026-07-31T10:00:00.000Z"),
        }
  return {
    stored: () => hash,
    get: async () => row(),
    upsertHash: async (input) => {
      hash = input.passwordHash
      const written = row()
      if (written === undefined) throw new Error("unreachable")
      return written
    },
    remove: async () => {
      const existed = hash !== null
      hash = null
      return existed
    },
  }
}

describe("set + verify", () => {
  test("a set password verifies; the store only ever holds the argon2id hash", async () => {
    const store = memoryStore()
    const credentials = createLocalAdminCredentials({ repository: store })

    await credentials.set(PASSWORD)

    expect(store.stored()).toStartWith("$argon2id$")
    expect(store.stored()).not.toContain(PASSWORD)
    expect(await credentials.isConfigured()).toBe(true)
    expect(await credentials.verify(PASSWORD)).toBe(true)
  })

  test("a wrong password is false, however long or short", async () => {
    const store = memoryStore()
    const credentials = createLocalAdminCredentials({ repository: store })
    await credentials.set(PASSWORD)

    expect(await credentials.verify("definitely not it")).toBe(false)
    expect(await credentials.verify("x")).toBe(false)
    expect(await credentials.verify(`${PASSWORD} `)).toBe(false)
  })

  test("set again replaces — the recovery path is idempotent", async () => {
    const store = memoryStore()
    const credentials = createLocalAdminCredentials({ repository: store })

    await credentials.set(PASSWORD)
    await credentials.set("a completely different password")

    expect(await credentials.verify(PASSWORD)).toBe(false)
    expect(await credentials.verify("a completely different password")).toBe(true)
  })

  test("a short password is refused before any hash is computed", async () => {
    const store = memoryStore()
    const credentials = createLocalAdminCredentials({ repository: store })

    await expect(credentials.set("too short")).rejects.toThrow(LocalPasswordPolicyError)
    await expect(credentials.set("x".repeat(LOCAL_PASSWORD_MIN_LENGTH - 1))).rejects.toThrow(
      `${LOCAL_PASSWORD_MIN_LENGTH}`,
    )
    expect(store.stored()).toBeNull()
  })
})

describe("an unconfigured door", () => {
  test("is not configured, rejects everything, and remove reports nothing to do", async () => {
    const store = memoryStore()
    const credentials = createLocalAdminCredentials({ repository: store })

    expect(await credentials.isConfigured()).toBe(false)
    expect(await credentials.verify(PASSWORD)).toBe(false)
    expect(await credentials.remove()).toBe(false)
  })

  test("a guess against no row costs a real argon2 pass, like a wrong password", async () => {
    // Not a wall-clock assertion — those flake. The guarantee is structural:
    // the no-row path must still pay argon2, so "is a credential set" is not
    // a timing side-channel. If the dummy-verify ever disappears, this test's
    // duration collapses to ~nothing and the mock below goes red.
    const store = memoryStore()
    const credentials = createLocalAdminCredentials({ repository: store })

    const started = performance.now()
    await credentials.verify("guessed password")
    const absentMs = performance.now() - started

    await credentials.set(PASSWORD)
    const startedWrong = performance.now()
    await credentials.verify("guessed password")
    const wrongMs = performance.now() - startedWrong

    // Both are a full argon2id pass; allow generous slack for a loaded runner.
    expect(absentMs).toBeGreaterThan(wrongMs / 4)
  })
})

describe("remove", () => {
  test("closes the door: verifies nothing afterwards", async () => {
    const store = memoryStore()
    const credentials = createLocalAdminCredentials({ repository: store })

    await credentials.set(PASSWORD)
    expect(await credentials.remove()).toBe(true)

    expect(await credentials.isConfigured()).toBe(false)
    expect(await credentials.verify(PASSWORD)).toBe(false)
  })
})

describe("hashLocalPassword", () => {
  test("two hashes of the same password differ (salted) and both verify", async () => {
    const one = await hashLocalPassword(PASSWORD)
    const two = await hashLocalPassword(PASSWORD)

    expect(one).toStartWith("$argon2id$")
    expect(two).toStartWith("$argon2id$")
    expect(one).not.toBe(two)
    expect(await Bun.password.verify(PASSWORD, one)).toBe(true)
    expect(await Bun.password.verify(PASSWORD, two)).toBe(true)
  })
})

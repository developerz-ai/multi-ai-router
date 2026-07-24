import { describe, expect, test } from "bun:test"
import { ARGON2ID_PARAMS, createPasswordVerifier } from "../../../src/services/admin-auth/password"

/**
 * argon2id, both credential forms, no I/O. `config/env.ts` already applied the precedence rule
 * (a hash wins over a plaintext password), so this only covers what happens after.
 */

describe("createPasswordVerifier", () => {
  test("hashes a plaintext ADMIN_PASSWORD at construction and verifies against it", async () => {
    const verifier = createPasswordVerifier({ kind: "password", value: "hunter2" })
    await verifier.ready()

    expect(await verifier.verify("hunter2")).toBe(true)
    expect(await verifier.verify("hunter3")).toBe(false)
    expect(await verifier.verify("")).toBe(false)
  })

  test("uses a pre-computed ADMIN_PASSWORD_HASH as-is", async () => {
    const hash = await Bun.password.hash("correct horse", ARGON2ID_PARAMS)
    const verifier = createPasswordVerifier({ kind: "hash", value: hash })

    expect(await verifier.verify("correct horse")).toBe(true)
    expect(await verifier.verify("battery staple")).toBe(false)
  })

  test("emits an argon2id PHC hash with the pinned parameters", async () => {
    const hash = await Bun.password.hash("whatever", ARGON2ID_PARAMS)

    expect(hash.startsWith("$argon2id$")).toBe(true)
    expect(hash).toContain(`m=${ARGON2ID_PARAMS.memoryCost}`)
    expect(hash).toContain(`t=${ARGON2ID_PARAMS.timeCost}`)
  })

  test("fails closed on a stored hash it cannot parse, rather than throwing a 500", async () => {
    const verifier = createPasswordVerifier({ kind: "hash", value: "not-a-hash" })

    expect(await verifier.verify("anything")).toBe(false)
  })

  test("refuses a non-argon2id hash — a hostile ADMIN_PASSWORD_HASH cannot downgrade it", async () => {
    const bcrypt = await Bun.password.hash("hunter2", { algorithm: "bcrypt", cost: 4 })
    const verifier = createPasswordVerifier({ kind: "hash", value: bcrypt })

    expect(await verifier.verify("hunter2")).toBe(false)
  })
})

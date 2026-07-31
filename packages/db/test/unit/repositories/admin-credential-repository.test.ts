import { describe, expect, test } from "bun:test"
import {
  ADMIN_CREDENTIAL_SINGLETON,
  createAdminCredentialRepository,
} from "../../../src/repositories/admin-credential-repository"
import { harness } from "./fixtures"

/**
 * No database required — see `fixtures.ts` for the proxy-driver seam.
 *
 * What is worth locking here: every statement is pinned to the fixed singleton
 * id (the table can never grow a second row through this repository), the write
 * is one `INSERT … ON CONFLICT` (the recovery path is idempotent by
 * construction), and the hash crosses the boundary verbatim — this repository
 * never sees the plaintext password.
 */

/** An argon2id PHC string, exactly as the service layer produces it. */
const HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$c2FsdHNhbHRzYWx0$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const NOW = new Date("2026-07-31T12:00:00.000Z")

/** Row order matches `select *` on `admin_credentials`. */
const credentialRow = [
  ADMIN_CREDENTIAL_SINGLETON,
  HASH,
  "2026-07-31 12:00:00+00",
  "2026-07-31 12:00:00+00",
]

describe("get", () => {
  test("selects by the singleton id, limited to one row", async () => {
    const stub = harness([credentialRow])
    const row = await createAdminCredentialRepository(stub.db).get()

    const { sql, params } = stub.only()
    expect(sql).toContain('from "admin_credentials"')
    expect(params[0]).toBe(ADMIN_CREDENTIAL_SINGLETON)
    expect(row?.id).toBe(ADMIN_CREDENTIAL_SINGLETON)
    expect(row?.passwordHash).toBe(HASH)
  })

  test("answers undefined when the door is off", async () => {
    const stub = harness([])
    expect(await createAdminCredentialRepository(stub.db).get()).toBeUndefined()
  })
})

describe("upsertHash", () => {
  test("is one insert-on-conflict against the singleton id, hash verbatim", async () => {
    const stub = harness([credentialRow])
    const row = await createAdminCredentialRepository(stub.db).upsertHash({
      passwordHash: HASH,
      now: NOW,
    })

    const { sql, params } = stub.only()
    expect(sql).toContain('insert into "admin_credentials"')
    expect(sql).toContain("on conflict")
    expect(params).toContain(ADMIN_CREDENTIAL_SINGLETON)
    expect(params).toContain(HASH)
    expect(params).not.toContain("hunter2")
    expect(row.passwordHash).toBe(HASH)
  })

  test("throws when the write returns no row", async () => {
    const stub = harness([])
    await expect(
      createAdminCredentialRepository(stub.db).upsertHash({ passwordHash: HASH, now: NOW }),
    ).rejects.toThrow("returned no row")
  })
})

describe("remove", () => {
  test("deletes by the singleton id and reports whether one existed", async () => {
    const existed = harness([["local"]])
    expect(await createAdminCredentialRepository(existed.db).remove()).toBe(true)
    expect(existed.only().sql).toContain('delete from "admin_credentials"')

    const absent = harness([])
    expect(await createAdminCredentialRepository(absent.db).remove()).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import { createOauthStateRepository } from "../../../src/repositories/oauth-state-repository"
import { harness } from "./fixtures"

/**
 * No database required — see `fixtures.ts` for the proxy-driver seam.
 *
 * What is worth locking here: `codeVerifier` crosses the boundary as ciphertext
 * in both directions, and `consume` is a single atomic UPDATE guarded by
 * "unconsumed and unexpired" — the check and the write happen in one statement
 * on purpose, so two concurrent presentations of the same `state` cannot both
 * pass. `deleteExpiredBefore` is covered once, for every sweep, in
 * `bounded-delete.test.ts`.
 */

/** A stored envelope, exactly as `CredentialCipher.encrypt` writes it. */
const ENVELOPE = "v1.k1.AQEBAQEBAQEBAQEB.AgICAgICAgICAgICAgICAg.CQgHBgU"

const STATE_ID = "77777777-7777-7777-7777-777777777777"
const ACCOUNT_ID = "88888888-8888-8888-8888-888888888888"
const NOW = new Date("2026-07-24T12:00:00.000Z")
const EXPIRES = new Date("2026-07-24T12:10:00.000Z")

/** Row order matches `select *` on `oauth_states`. */
const oauthStateRow = [
  STATE_ID,
  "opaque-state-value",
  ENVELOPE,
  "chatgpt",
  ACCOUNT_ID,
  "https://router.example.com/callback",
  null,
  "2026-07-24 12:10:00+00",
  "2026-07-24 12:00:00+00",
]

describe("create", () => {
  test("inserts one oauth_states row and returns it", async () => {
    const stub = harness([oauthStateRow])
    const row = await createOauthStateRepository(stub.db).create({
      state: "opaque-state-value",
      codeVerifier: ENVELOPE,
      provider: "chatgpt",
      accountId: ACCOUNT_ID,
      redirectUri: "https://router.example.com/callback",
      expiresAt: EXPIRES,
    })

    const { sql, params } = stub.only()
    expect(sql).toContain('insert into "oauth_states"')
    expect(sql).toContain("returning")
    expect(params).toContain(ENVELOPE)
    expect(row.id).toBe(STATE_ID)
  })

  test("stores the PKCE verifier as ciphertext, never plaintext, verbatim", async () => {
    const stub = harness([oauthStateRow])
    await createOauthStateRepository(stub.db).create({
      state: "opaque-state-value",
      codeVerifier: ENVELOPE,
      provider: "chatgpt",
      expiresAt: EXPIRES,
    })

    // Bound as a parameter, byte-identical to the envelope the service layer
    // produced — nothing here inspects or re-encodes it.
    expect(stub.only().params).toContain(ENVELOPE)
  })

  test("writes explicit nulls for the manual paste mode, which has no redirect", async () => {
    const stub = harness([oauthStateRow])
    await createOauthStateRepository(stub.db).create({
      state: "opaque-state-value",
      codeVerifier: ENVELOPE,
      provider: "chatgpt",
      expiresAt: EXPIRES,
    })

    expect(stub.only().params).toContain(null)
  })

  test("throws when the statement returns no row", async () => {
    const stub = harness([])
    await expect(
      createOauthStateRepository(stub.db).create({
        state: "opaque-state-value",
        codeVerifier: ENVELOPE,
        provider: "chatgpt",
        expiresAt: EXPIRES,
      }),
    ).rejects.toThrow("oauthStateRepository.create: statement returned no row")
  })
})

describe("consume", () => {
  test("redeems a state in one atomic update, guarded by unconsumed and unexpired", async () => {
    const stub = harness([oauthStateRow])
    const row = await createOauthStateRepository(stub.db).consume("opaque-state-value", NOW)

    const { sql, params } = stub.only()
    expect(sql).toContain('update "oauth_states" set')
    expect(sql).toContain('"consumed_at" = $1')
    expect(sql).toContain('"state" = $2')
    expect(sql).toContain('"consumed_at" is null')
    expect(sql).toContain('"expires_at" > $3')
    expect(params).toEqual([NOW.toISOString(), "opaque-state-value", NOW.toISOString()])
    expect(row?.id).toBe(STATE_ID)
  })

  test("returns undefined for an unknown, already-consumed, or expired state alike", async () => {
    const stub = harness([])
    expect(
      await createOauthStateRepository(stub.db).consume("opaque-state-value", NOW),
    ).toBeUndefined()
  })

  test("is a single statement — no separate read before the write", async () => {
    const stub = harness([oauthStateRow])
    await createOauthStateRepository(stub.db).consume("opaque-state-value", NOW)

    expect(stub.statements).toHaveLength(1)
  })
})

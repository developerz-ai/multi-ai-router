import { describe, expect, test } from "bun:test"
import { createSessionRepository } from "../../../src/repositories/session-repository"
import { harness } from "./fixtures"

/**
 * No database required — see `fixtures.ts` for the proxy-driver seam.
 *
 * What is worth locking here: that a session is scoped to the key that owns it,
 * that an absent field on `upsert` leaves the stored value alone while an
 * explicit `null` clears it, and that `clearAccount` invalidates a binding
 * without ever moving it — an SDK session id is meaningless off the account
 * that minted it. `deleteIdleBefore` is covered once, for every sweep, in
 * `bounded-delete.test.ts`.
 */

const SESSION_ID = "44444444-4444-4444-4444-444444444444"
const API_KEY_ID = "55555555-5555-5555-5555-555555555555"
const ACCOUNT_ID = "66666666-6666-6666-6666-666666666666"
const NOW = new Date("2026-07-24T12:00:00.000Z")
/** Drizzle maps a `timestamp with time zone` to an ISO string before it reaches the driver. */
const NOW_PARAM = NOW.toISOString()

/** Row order matches `select *` on `sessions`. */
const sessionRow = [
  SESSION_ID,
  "client-session-key",
  API_KEY_ID,
  ACCOUNT_ID,
  "sdk-session-1",
  null,
  "header",
  "2026-07-24 12:00:00+00",
  "2026-07-01 00:00:00+00",
]

describe("findByKey", () => {
  test("scopes the lookup to the api key, so two keys never share a binding", async () => {
    const stub = harness([sessionRow])
    const row = await createSessionRepository(stub.db).findByKey(API_KEY_ID, "client-session-key")

    const { sql, params } = stub.only()
    expect(sql).toContain('from "sessions"')
    expect(sql).toContain('"sessions"."api_key_id" = $1')
    expect(sql).toContain('"sessions"."key" = $2')
    expect(params).toEqual([API_KEY_ID, "client-session-key", 1])
    expect(row?.id).toBe(SESSION_ID)
  })

  test("returns undefined when nothing matches", async () => {
    const stub = harness([])
    expect(
      await createSessionRepository(stub.db).findByKey(API_KEY_ID, "unknown-key"),
    ).toBeUndefined()
  })
})

describe("upsert", () => {
  test("inserts on first use, keyed on (apiKeyId, key)", async () => {
    const stub = harness([sessionRow])
    const row = await createSessionRepository(stub.db).upsert({
      apiKeyId: API_KEY_ID,
      key: "client-session-key",
      accountId: ACCOUNT_ID,
      sdkSessionId: "sdk-session-1",
      lastUsedAt: NOW,
    })

    const { sql, params } = stub.only()
    expect(sql).toContain('insert into "sessions"')
    expect(sql).toContain('on conflict ("api_key_id","key") do update set')
    expect(params).toContain(ACCOUNT_ID)
    expect(params).toContain(NOW_PARAM)
    expect(row.id).toBe(SESSION_ID)
  })

  test("an absent field leaves the stored value alone on conflict", async () => {
    const stub = harness([sessionRow])
    await createSessionRepository(stub.db).upsert({
      apiKeyId: API_KEY_ID,
      key: "client-session-key",
      lastUsedAt: NOW,
    })

    // Only lastUsedAt is bound to the update; accountId/sdkSessionId/lineageState/
    // fingerprintSource are untouched, so `set` cannot mention them.
    const { sql } = stub.only()
    expect(sql).not.toContain('"account_id" = $')
    expect(sql).not.toContain('"sdk_session_id" = $')
  })

  test("an explicit null clears the binding instead of leaving it untouched", async () => {
    const stub = harness([sessionRow])
    await createSessionRepository(stub.db).upsert({
      apiKeyId: API_KEY_ID,
      key: "client-session-key",
      accountId: null,
      sdkSessionId: null,
      lineageState: null,
      lastUsedAt: NOW,
    })

    const { sql, params } = stub.only()
    expect(sql).toContain('"account_id" = $')
    expect(params).toContain(null)
  })

  test("throws when the statement returns no row", async () => {
    const stub = harness([])
    await expect(
      createSessionRepository(stub.db).upsert({
        apiKeyId: API_KEY_ID,
        key: "client-session-key",
        lastUsedAt: NOW,
      }),
    ).rejects.toThrow("sessionRepository.upsert: statement returned no row")
  })
})

describe("clearAccount", () => {
  test("invalidates every binding onto an account, and returns how many", async () => {
    const stub = harness([[SESSION_ID]])
    const cleared = await createSessionRepository(stub.db).clearAccount(ACCOUNT_ID)

    const { sql, params } = stub.only()
    expect(sql).toContain('update "sessions" set')
    expect(sql).toContain('"account_id" = $1')
    expect(sql).toContain('"sdk_session_id" = $2')
    expect(sql).toContain('"lineage_state" = $3')
    expect(params).toEqual([null, null, null, ACCOUNT_ID])
    expect(cleared).toBe(1)
  })

  test("never touches lastUsedAt — a cleared row still ages out on its own clock", async () => {
    const stub = harness([[SESSION_ID]])
    await createSessionRepository(stub.db).clearAccount(ACCOUNT_ID)

    expect(stub.only().sql).not.toContain('"last_used_at"')
  })

  test("returns zero when no session is bound to the account", async () => {
    const stub = harness([])
    expect(await createSessionRepository(stub.db).clearAccount(ACCOUNT_ID)).toBe(0)
  })
})

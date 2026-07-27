import { describe, expect, test } from "bun:test"
import { createAccountRepository } from "../../../src/repositories/account-repository"
import { harness } from "./fixtures"

/**
 * No database required — see `fixtures.ts` for the proxy-driver seam.
 *
 * What is worth locking here: which table each method touches, which predicate
 * narrows it, and — the rule this repository exists to enforce — that
 * `auth_material` crosses the boundary as ciphertext in both directions, with
 * nothing in between attempting to read it.
 */

/** A stored envelope, exactly as `CredentialCipher.encrypt` writes it. */
const ENVELOPE = "v1.k1.AQEBAQEBAQEBAQEB.AgICAgICAgICAgICAgICAg.CQgHBgU"

const ACCOUNT_ID = "11111111-1111-1111-1111-111111111111"
const NOW = new Date("2026-07-24T12:00:00.000Z")
/** Drizzle maps a `timestamp with time zone` to an ISO string before it reaches the driver. */
const NOW_PARAM = NOW.toISOString()

/** Row order matches `select *` on `accounts`, which is how postgres answers. */
const accountRow = [
  ACCOUNT_ID,
  "claude-max-seb",
  "anthropic-oauth",
  "active",
  "subscription",
  ENVELOPE,
  null,
  null,
  null,
  100,
  0,
  "2026-07-01 00:00:00+00",
  "2026-07-01 00:00:00+00",
]

describe("create", () => {
  test("inserts one accounts row and returns it", async () => {
    const stub = harness([accountRow])
    const row = await createAccountRepository(stub.db).create({
      label: "claude-max-seb",
      provider: "anthropic-oauth",
      configDir: "/data/claude/seb",
    })

    expect(stub.only().sql).toContain('insert into "accounts"')
    expect(stub.only().sql).toContain("returning")
    expect(row.id).toBe(ACCOUNT_ID)
    expect(row.label).toBe("claude-max-seb")
  })

  test("stores auth material verbatim — the repository never encrypts or inspects it", async () => {
    const stub = harness([accountRow])
    await createAccountRepository(stub.db).create({
      label: "zai-1",
      provider: "zai",
      authMaterial: ENVELOPE,
    })

    // Bound as a parameter, byte-identical to what the service layer produced.
    expect(stub.only().params).toContain(ENVELOPE)
  })

  test("writes an explicit null when an account holds no router-managed credential", async () => {
    const stub = harness([accountRow])
    await createAccountRepository(stub.db).create({
      label: "claude-max-team",
      provider: "anthropic-oauth",
      configDir: "/data/claude/team",
    })

    expect(stub.only().params).toContain(null)
    expect(stub.only().params).not.toContain(ENVELOPE)
  })

  test("leaves weight, priority and status to the schema defaults when unset", async () => {
    const stub = harness([accountRow])
    await createAccountRepository(stub.db).create({ label: "zai-1", provider: "zai" })

    // Only the two required columns and the seven nullable ones are bound; the
    // rest are `default` in the statement, so the schema stays the authority.
    expect(stub.only().params).toEqual(["zai-1", "zai", null, null, null, null, null, null, null])
    expect(stub.only().sql).toContain("default")
  })
})

describe("reads return the stored ciphertext untouched", () => {
  test("findById narrows by id and returns the envelope as stored", async () => {
    const stub = harness([accountRow])
    const row = await createAccountRepository(stub.db).findById(ACCOUNT_ID)

    expect(stub.only().sql).toContain('from "accounts"')
    expect(stub.only().sql).toContain('"accounts"."id" = $1')
    expect(stub.only().params).toEqual([ACCOUNT_ID, 1])
    expect(row?.authMaterial).toBe(ENVELOPE)
  })

  test("findById returns undefined when nothing matches", async () => {
    const stub = harness([])
    expect(await createAccountRepository(stub.db).findById(ACCOUNT_ID)).toBeUndefined()
  })

  test("list without a filter returns every account, oldest first", async () => {
    const stub = harness([accountRow])
    const rows = await createAccountRepository(stub.db).list()

    expect(stub.only().sql).not.toContain("where")
    expect(stub.only().sql).toContain('order by "accounts"."created_at"')
    expect(stub.only().params).toEqual([])
    expect(rows[0]?.authMaterial).toBe(ENVELOPE)
  })

  test("list with a status filter narrows in SQL, not in memory", async () => {
    const stub = harness([accountRow])
    await createAccountRepository(stub.db).list({ status: "cooling_down" })

    expect(stub.only().sql).toContain('"accounts"."status" = $1')
    expect(stub.only().params).toEqual(["cooling_down"])
  })

  test("no read method selects anything but the ciphertext column", async () => {
    const stub = harness([accountRow])
    const repository = createAccountRepository(stub.db)
    await repository.findById(ACCOUNT_ID)
    await repository.list()

    for (const statement of stub.statements) {
      expect(statement.sql).toContain('"auth_material"')
      // Decryption is the service layer's job; nothing is unwrapped in SQL.
      expect(statement.sql).not.toMatch(/decrypt|pgp_sym|pgcrypto/i)
    }
  })
})

describe("status is the lifecycle, and disable is the soft delete", () => {
  test("updateStatus sets the status and the updated_at stamp it was given", async () => {
    const stub = harness([accountRow])
    await createAccountRepository(stub.db).updateStatus(ACCOUNT_ID, "needs_reauth", NOW)

    expect(stub.only().sql).toContain('update "accounts" set')
    expect(stub.only().sql).toContain('"status" = $1')
    expect(stub.only().params).toEqual(["needs_reauth", NOW_PARAM, ACCOUNT_ID])
  })

  test("updateStatus returns undefined for an unknown id", async () => {
    const stub = harness([])
    expect(
      await createAccountRepository(stub.db).updateStatus(ACCOUNT_ID, "active", NOW),
    ).toBeUndefined()
  })

  test("disable updates the row instead of deleting it, so history stays joinable", async () => {
    const stub = harness([accountRow])
    await createAccountRepository(stub.db).disable(ACCOUNT_ID, NOW)

    expect(stub.only().sql).toContain('update "accounts" set')
    expect(stub.only().sql).not.toContain("delete")
    expect(stub.only().params).toEqual(["disabled", NOW_PARAM, ACCOUNT_ID])
  })

  test("updateStatusWhen narrows on the id and on the statuses it may overwrite", async () => {
    const stub = harness([accountRow])
    await createAccountRepository(stub.db).updateStatusWhen(
      ACCOUNT_ID,
      ["active", "cooling_down"],
      "exhausted",
      NOW,
    )

    // The guard is a predicate, not a read-then-write: several replicas observe the same account
    // concurrently and a check in TypeScript would be a race.
    expect(stub.only().sql).toContain('update "accounts" set')
    expect(stub.only().sql).toContain('"status" in ($4, $5)')
    expect(stub.only().params).toEqual([
      "exhausted",
      NOW_PARAM,
      ACCOUNT_ID,
      "active",
      "cooling_down",
    ])
  })

  test("updateStatusWhen returns undefined when the row held something outside the guard", async () => {
    // Postgres answers zero rows, which is exactly how "the operator's `disabled` was not
    // overwritten" reaches the caller.
    const stub = harness([])
    expect(
      await createAccountRepository(stub.db).updateStatusWhen(
        ACCOUNT_ID,
        ["active"],
        "exhausted",
        NOW,
      ),
    ).toBeUndefined()
  })

  test("an empty guard admits nothing, and issues no statement at all", async () => {
    // `in ()` is not a predicate postgres accepts, so "nothing may be overwritten" must not be
    // allowed to render as a statement that means something else.
    const stub = harness([accountRow])
    expect(
      await createAccountRepository(stub.db).updateStatusWhen(ACCOUNT_ID, [], "exhausted", NOW),
    ).toBeUndefined()
    expect(stub.statements).toHaveLength(0)
  })
})

describe("quota window state", () => {
  /** Row order matches `select *` on `quota_windows`. */
  const quotaRow = [
    "22222222-2222-2222-2222-222222222222",
    ACCOUNT_ID,
    "five_hour",
    0.42,
    "continuous",
    "2026-07-24 17:00:00+00",
    "provider-reported",
    "2026-07-24 12:00:00+00",
    "2026-07-24 12:00:00+00",
  ]

  test("upserts one window per account, keyed on (account_id, window)", async () => {
    const stub = harness([quotaRow])
    const row = await createAccountRepository(stub.db).upsertQuotaWindow(ACCOUNT_ID, {
      window: "five_hour",
      utilization: 0.42,
      utilizationSource: "continuous",
      resetsAt: new Date("2026-07-24T17:00:00.000Z"),
      resetSource: "provider-reported",
      lastCheckedAt: NOW,
    })

    const { sql, params } = stub.only()
    expect(sql).toContain('insert into "quota_windows"')
    expect(sql).toContain('on conflict ("account_id","window") do update set')
    expect(params).toContain(ACCOUNT_ID)
    expect(params).toContain("five_hour")
    expect(params).toContain(0.42)
    expect(row.utilization).toBe(0.42)
  })

  test("writes NULL when a threshold-triggered source reports no utilization", async () => {
    const stub = harness([quotaRow])
    await createAccountRepository(stub.db).upsertQuotaWindow(ACCOUNT_ID, {
      window: "seven_day",
      utilizationSource: "threshold-triggered",
      resetSource: "unknown",
      lastCheckedAt: NOW,
    })

    // A stale number left on display is worse than an empty gauge, so the
    // absent reading is written, not skipped.
    expect(stub.only().params).toContain(null)
    expect(stub.only().params).not.toContain(0.42)
  })

  test("an exhausted account carries no reset, and none is invented", async () => {
    const stub = harness([quotaRow])
    await createAccountRepository(stub.db).upsertQuotaWindow(ACCOUNT_ID, {
      window: "seven_day_opus",
      utilization: 1,
      utilizationSource: "continuous",
      resetSource: "unknown",
      lastCheckedAt: NOW,
    })

    // The only timestamps bound are the two `lastCheckedAt` stamps — insert and
    // conflict-update. No reset is fabricated for an account that has none.
    const timestamps = stub.only().params.filter((param) => param === NOW_PARAM)
    expect(timestamps).toHaveLength(2)
    expect(stub.only().params).toContain(null)
  })

  test("listQuotaWindows reads every window for a set of accounts in one query", async () => {
    const stub = harness([quotaRow])
    const other = "33333333-3333-3333-3333-333333333333"
    const rows = await createAccountRepository(stub.db).listQuotaWindows([ACCOUNT_ID, other])

    // The catalog hydrates a whole pool at load; one query per account would be
    // one round trip per account.
    const { sql, params } = stub.only()
    expect(sql).toContain('from "quota_windows"')
    expect(sql).toContain('"quota_windows"."account_id" in ($1, $2)')
    expect(params).toEqual([ACCOUNT_ID, other])
    expect(rows[0]?.window).toBe("five_hour")
  })

  test("listQuotaWindows orders by account then window, so grouping is stable", async () => {
    const stub = harness([quotaRow])
    await createAccountRepository(stub.db).listQuotaWindows([ACCOUNT_ID])

    expect(stub.only().sql).toContain(
      'order by "quota_windows"."account_id" asc, "quota_windows"."window" asc',
    )
  })

  test("listQuotaWindows asks nothing of the database for an empty set", async () => {
    const stub = harness([quotaRow])
    // `in ()` is what a missing guard produces, and it is not what an empty
    // input means: a caller with no accounts has nothing to hydrate.
    expect(await createAccountRepository(stub.db).listQuotaWindows([])).toEqual([])
    expect(stub.statements).toHaveLength(0)
  })
})

import { describe, expect, test } from "bun:test"
import type { Database } from "../../../src/client"
import { createApiKeyRepository } from "../../../src/repositories/api-key-repository"
import { createAuditRepository } from "../../../src/repositories/audit-repository"
import { createOauthStateRepository } from "../../../src/repositories/oauth-state-repository"
import { createSessionRepository } from "../../../src/repositories/session-repository"
import { createUsageRecordRepository } from "../../../src/repositories/usage-repository"
import { deletedRows, harness } from "./fixtures"

/**
 * Every retention sweep in the scheduler goes through one delete shape, and two
 * properties of that shape are the whole point of it: the batch is bounded, and
 * the count comes back so a run that filled its batch can report `partial`
 * instead of claiming it is caught up.
 *
 * Locked here per table because the sweep runs against live write traffic — an
 * unbounded `delete … where created_at < cutoff` takes row locks across the
 * whole table, and the write-heaviest table in the schema is one of these.
 */

const CUTOFF = new Date("2026-06-25T00:00:00.000Z")
/** Drizzle maps a `timestamp with time zone` to an ISO string before the driver sees it. */
const CUTOFF_PARAM = CUTOFF.toISOString()

interface Sweep {
  readonly name: string
  readonly table: string
  readonly ageColumn: string
  run(db: Database, limit: number): Promise<number>
}

const SWEEPS: readonly Sweep[] = [
  {
    name: "usage records",
    table: "usage_records",
    ageColumn: "created_at",
    run: (db, limit) => createUsageRecordRepository(db).deleteOlderThan(CUTOFF, limit),
  },
  {
    name: "audit events",
    table: "audit_events",
    ageColumn: "created_at",
    run: (db, limit) => createAuditRepository(db).deleteOlderThan(CUTOFF, limit),
  },
  {
    name: "revoked keys",
    table: "api_keys",
    ageColumn: "revoked_at",
    run: (db, limit) => createApiKeyRepository(db).deleteRevokedOlderThan(CUTOFF, limit),
  },
  {
    name: "idle sessions",
    table: "sessions",
    ageColumn: "last_used_at",
    run: (db, limit) => createSessionRepository(db).deleteIdleBefore(CUTOFF, limit),
  },
  {
    name: "expired oauth states",
    table: "oauth_states",
    ageColumn: "expires_at",
    run: (db, limit) => createOauthStateRepository(db).deleteExpiredBefore(CUTOFF, limit),
  },
]

describe("every sweep deletes a bounded batch, oldest first", () => {
  for (const sweep of SWEEPS) {
    test(`${sweep.name}: one statement, id-limited by an ordered subselect`, async () => {
      const stub = harness()
      await sweep.run(stub.db, 1000)

      // Postgres accepts no LIMIT on a DELETE, so the bound has to arrive as a
      // subselect. Anything else here is an unbounded delete.
      const { sql, params } = stub.only()
      expect(sql).toContain(`delete from "${sweep.table}"`)
      expect(sql).toContain(`"${sweep.table}"."id" in (select "id" from "${sweep.table}"`)
      expect(sql).toContain(`order by "${sweep.table}"."${sweep.ageColumn}" asc limit`)
      expect(params).toContain(1000)
    })

    test(`${sweep.name}: narrows by age with a strict comparison, never a range scan of the table`, async () => {
      const stub = harness()
      await sweep.run(stub.db, 50)

      const { sql, params } = stub.only()
      expect(sql).toContain(`"${sweep.table}"."${sweep.ageColumn}" < $1`)
      expect(params[0]).toBe(CUTOFF_PARAM)
    })

    test(`${sweep.name}: returns rows affected, so a full batch reads as partial`, async () => {
      const caughtUp = harness(deletedRows(7))
      expect(await sweep.run(caughtUp.db, 50)).toBe(7)

      const filled = harness(deletedRows(50))
      // The caller compares against its own limit; the repository states the
      // fact and draws no conclusion from it.
      expect(await sweep.run(filled.db, 50)).toBe(50)

      const empty = harness()
      expect(await sweep.run(empty.db, 50)).toBe(0)
    })
  }
})

describe("what each sweep is allowed to reach", () => {
  test("revoked keys: the flag narrows the batch, not just the timestamp", async () => {
    const stub = harness()
    await createApiKeyRepository(stub.db).deleteRevokedOlderThan(CUTOFF, 100)

    // `revoked` is what verification reads, so requiring it means the sweep can
    // only ever reach a key that is already refused.
    const { sql, params } = stub.only()
    expect(sql).toContain('"api_keys"."revoked" = $2')
    expect(params).toContain(true)
  })

  test("revoked keys: a revocation with no timestamp has no age and is never purged", async () => {
    const stub = harness()
    await createApiKeyRepository(stub.db).deleteRevokedOlderThan(CUTOFF, 100)

    // `revoked_at < cutoff` excludes NULL in SQL, and nothing here coalesces it
    // into a date. Unpurged is recoverable; purged is not.
    const { sql } = stub.only()
    expect(sql).not.toMatch(/coalesce|is null/i)
  })

  test("audit events: age is the only predicate a caller can supply", async () => {
    const stub = harness()
    await createAuditRepository(stub.db).deleteOlderThan(CUTOFF, 100)

    // A retention window is policy. A delete that can name a kind or a subject
    // is an edit, and an audit trail that can be edited is not one.
    const { sql } = stub.only()
    expect(sql).not.toContain("subject_id")
    expect(sql).not.toContain('"kind"')
    expect(stub.only().params).toEqual([CUTOFF_PARAM, 100])
  })

  test("usage records: the sweep touches raw attempts only, never the rollup", async () => {
    const stub = harness()
    await createUsageRecordRepository(stub.db).deleteOlderThan(CUTOFF, 100)

    // A totals report must not shrink because the attempts behind it aged out.
    expect(stub.only().sql).not.toContain("usage_daily")
  })

  test("idle sessions: aged on last use, so a live conversation is never swept", async () => {
    const stub = harness()
    await createSessionRepository(stub.db).deleteIdleBefore(CUTOFF, 100)

    const { sql } = stub.only()
    expect(sql).toContain('"sessions"."last_used_at" < $1')
    expect(sql).not.toContain("created_at")
  })
})

import { describe, expect, test } from "bun:test"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

/**
 * 0044 is hand-ordered and guarded statement by statement. Replaying it over a schema that
 * already has it — a restore replayed over a newer database — must change nothing and fail on
 * nothing, and the resulting indexes must be exactly the ones the slice promised.
 */
const fixture = ownDatabaseFixture("migration_0044")

const DROPPED = [
  "accounts_provider_idx",
  "accounts_status_idx",
  "accounts_last_used_at_idx",
  "model_catalog_model_id_idx",
  "quota_windows_resets_at_idx",
  "usage_contributions_source_idx",
]

async function statements(): Promise<string[]> {
  const file = await Bun.file(
    new URL("../../migrations/0044_index_hygiene.sql", import.meta.url),
  ).text()
  return file
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

describe.skipIf(ownDatabaseUrl === "")("migration 0044", () => {
  test("leaves the promised indexes and constraints, and replays as a no-op", async () => {
    const sql = fixture.sql()
    const snapshot = async () =>
      sql<{ indexname: string; indexdef: string }[]>`
        select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname`
    const before = await snapshot()
    const names = before.map((row) => row.indexname)
    for (const dropped of DROPPED) expect(names).not.toContain(dropped)
    const def = (name: string) => before.find((row) => row.indexname === name)?.indexdef
    expect(def("usage_records_account_created_idx")).toContain(
      "(account_id, created_at) INCLUDE (tokens_in, tokens_out, cache_read_tokens, cache_write_tokens)",
    )
    expect(def("usage_contributions_legacy_day_idx")).toContain("WHERE (source <> 'live'::text)")
    expect(def("scheduled_task_runs_open_idx")).toContain("WHERE (finished_at IS NULL)")
    // Kept for the kind-filtered activity feed.
    expect(def("audit_events_kind_created_idx")).toContain("(kind, created_at)")

    for (const statement of await statements()) await sql.unsafe(statement)
    expect(await snapshot()).toEqual(before)
  })

  test("closed-set CHECKs refuse an out-of-set value on write", async () => {
    const sql = fixture.sql()
    const refused = await sql`
      insert into usage_contributions (id, kind, day, source, payload_hash, payload)
      values (gen_random_uuid(), 'attempt', '2026-11-10', 'made_up', 'h', '{}'::jsonb)`.catch(
      (error: unknown) => error,
    )
    expect(Reflect.get(refused as object, "code")).toBe("23514")
  })
})

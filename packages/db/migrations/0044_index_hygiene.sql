-- Index hygiene, the persisted exhausted re-test ladder, and closed-set CHECKs (plan 101, slice 08).
--
-- Hand-ordered from what drizzle-kit generates, and every statement guarded, so replaying the file
-- over a schema that already has it (a restore replayed over a newer database) is a no-op. Re-runs
-- in the normal path are skipped by drizzle's journal, not by these guards.
--
-- Locks. drizzle applies every pending file in ONE transaction, so each lock below is held until
-- the whole upgrade commits. `CREATE INDEX` takes SHARE on its table: usage writes on running
-- replicas wait for the build (they queue in the usage writer and retry; nothing is dropped). At
-- the measured prod scale (~0.7 M usage_records, ~0.4 M usage_contributions) each build is a few
-- seconds. Not `CONCURRENTLY`: that cannot run inside the migration transaction, and a failed
-- concurrent build leaves an INVALID index that `IF NOT EXISTS` would then skip forever. The builds
-- come first; the ACCESS EXCLUSIVE statements (DROP INDEX, ADD CONSTRAINT) come last so they are
-- held for the shortest time, and `runMigrations` bounds any lock wait with `lock_timeout`: a DDL
-- stuck behind a long usage read fails the boot (and is retried by the restart) instead of queueing
-- every later query on that table behind it.
--
-- CHECKs are `NOT VALID`: enforced on every new or updated row, not re-verified over existing rows.
-- Those rows were written by code typed to these exact sets; validating them at boot would turn an
-- unforeseen legacy value into a failed upgrade with no operator recourse.
--
-- Rollback: pin the previous image. Old binaries ignore the new table, the new indexes and the
-- CHECKs (they only write values inside the sets), and never needed the dropped indexes.

CREATE TABLE IF NOT EXISTS "account_exhausted_watches" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"retests" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"last_retest_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_exhausted_watches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "account_exhausted_watches_retests_nonnegative" CHECK ("account_exhausted_watches"."retests" >= 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_records_account_created_idx" ON "usage_records" USING btree ("account_id","created_at") INCLUDE ("tokens_in","tokens_out","cache_read_tokens","cache_write_tokens");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_contributions_legacy_day_idx" ON "usage_contributions" USING btree ("day") WHERE "usage_contributions"."source" <> 'live';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_task_runs_open_idx" ON "scheduled_task_runs" USING btree ("task","started_at") WHERE "scheduled_task_runs"."finished_at" is null;--> statement-breakpoint
-- Kept, not dropped: the activity feed now filters by kind. A no-op everywhere it already exists.
CREATE INDEX IF NOT EXISTS "audit_events_kind_created_idx" ON "audit_events" USING btree ("kind","created_at");--> statement-breakpoint
DROP INDEX IF EXISTS "accounts_provider_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "accounts_status_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "accounts_last_used_at_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "model_catalog_model_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "quota_windows_resets_at_idx";--> statement-breakpoint
ALTER TABLE "quota_windows" DROP CONSTRAINT IF EXISTS "quota_windows_evidence_state_known";--> statement-breakpoint
ALTER TABLE "quota_windows" ADD CONSTRAINT "quota_windows_evidence_state_known" CHECK ("quota_windows"."evidence_state" in ('current', 'expired', 'superseded_by_recovery')) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_attempt_daily_v2" DROP CONSTRAINT IF EXISTS "usage_attempt_daily_v2_basis_known";--> statement-breakpoint
ALTER TABLE "usage_attempt_daily_v2" ADD CONSTRAINT "usage_attempt_daily_v2_basis_known" CHECK ("usage_attempt_daily_v2"."basis" in ('live', 'legacy')) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_request_daily_v2" DROP CONSTRAINT IF EXISTS "usage_request_daily_v2_basis_known";--> statement-breakpoint
ALTER TABLE "usage_request_daily_v2" ADD CONSTRAINT "usage_request_daily_v2_basis_known" CHECK ("usage_request_daily_v2"."basis" in ('live', 'legacy')) NOT VALID;--> statement-breakpoint
DROP INDEX IF EXISTS "usage_contributions_source_idx";--> statement-breakpoint
ALTER TABLE "usage_contributions" DROP CONSTRAINT IF EXISTS "usage_contributions_kind_known";--> statement-breakpoint
ALTER TABLE "usage_contributions" ADD CONSTRAINT "usage_contributions_kind_known" CHECK ("usage_contributions"."kind" in ('attempt', 'terminal')) NOT VALID;--> statement-breakpoint
ALTER TABLE "usage_contributions" DROP CONSTRAINT IF EXISTS "usage_contributions_source_known";--> statement-breakpoint
ALTER TABLE "usage_contributions" ADD CONSTRAINT "usage_contributions_source_known" CHECK ("usage_contributions"."source" in ('live', 'legacy_pending', 'legacy_baseline', 'legacy_unbanked', 'legacy_overlap')) NOT VALID;

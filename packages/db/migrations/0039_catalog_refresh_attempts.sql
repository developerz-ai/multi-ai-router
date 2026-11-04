-- Per-account catalog-refresh attempt bookkeeping: one row per account the hourly sweep asked
-- for a catalog WITHOUT a write — a failed or skipped refresh. The timestamp is what the sweep
-- rotates on, and it now lives in Postgres rather than a per-replica map, so rotation survives a
-- restart and is shared across replicas (the advisory lock still lets exactly one replica run the
-- sweep per tick).
--
-- A second table rather than more columns on `model_catalog`, because "when was this account last
-- asked in vain" is one fact per account while the catalog is keyed (account_id, model_id) and a
-- failed ask writes nothing there. It is the sweep's own successful ask that clears the row —
-- `refreshed_at` then orders the account again. A catalog write from elsewhere — the
-- login-completion hook refreshes the account it just logged in without touching this table —
-- leaves the stamp in place, harmlessly: the sweep orders on the later of `refreshed_at` and
-- `last_attempted_at`, so the fresh write already sorts the account as refreshed. An account
-- never asked in vain has no row at all.
--
-- Delete the account and the bookkeeping is not stale, it is noise: the FK cascades it away.
--
-- Rollback is additive-only: pin the previous image tag. Old binaries ignore this extra table,
-- `model_catalog` rows are never touched, and the worst case is the old per-replica behavior (one
-- extra ask per failing account). `IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` are added by hand
-- to what drizzle-kit generates: boot migrations are promised idempotent (09-deployment.md), and
-- without the guards a database that already carries the table — a replica racing another through
-- boot, or a restore replayed over a newer schema — fails the whole migration and refuses to serve.
CREATE TABLE IF NOT EXISTS "model_catalog_attempts" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"last_attempted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_catalog_attempts" DROP CONSTRAINT IF EXISTS "model_catalog_attempts_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "model_catalog_attempts" ADD CONSTRAINT "model_catalog_attempts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;

-- `last_used_at`, and the keepalive sweep that reads it.
--
-- The column exists so "has this account gone unused" is one indexed question about
-- the account rather than a NOT EXISTS over `usage_records` — a table retention
-- prunes, which would silently turn "unused for a week" into "no surviving usage
-- row" the moment the retention window is the shorter of the two. NULL means never
-- used; the probe reads that as idle, which is the safe direction.
--
-- `ADD VALUE` is safe inside Drizzle's migration transaction on PG12+ because
-- nothing in this migration writes a row carrying the new value. `IF NOT EXISTS`
-- is added by hand to what drizzle-kit generates: boot migrations are promised
-- idempotent (09-deployment.md), and without it a database that already carries
-- the value — a replica racing another through boot, or a restore replayed over a
-- newer schema — fails the whole migration and refuses to serve.
ALTER TYPE "public"."scheduled_task" ADD VALUE IF NOT EXISTS 'idle_account_probe';--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "accounts_last_used_at_idx" ON "accounts" USING btree ("last_used_at");
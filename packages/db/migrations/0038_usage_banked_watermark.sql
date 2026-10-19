-- Banked-through watermark (issue #275): `backfill` records the (created_at, id) through which every
-- usage_records row has a non-pending contribution, so `coverage`'s `pending` check can scan only
-- the rows after it. Both columns NULL = no proof yet = scan everything (the pre-0038 behaviour).
-- The CHECK forbids a half-set pair, which would otherwise read as an unprovable watermark.
-- ADD COLUMN takes an ACCESS EXCLUSIVE lock on usage_history_state (one row) and may wait behind
-- long-running queries at boot.
-- IF NOT EXISTS on the columns, so a database that applied the columns-only draft of 0038 re-runs it cleanly.
ALTER TABLE "usage_history_state" ADD COLUMN IF NOT EXISTS "banked_through_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_history_state" ADD COLUMN IF NOT EXISTS "banked_through_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_history_state" ADD CONSTRAINT "usage_history_state_watermark_paired" CHECK (("usage_history_state"."banked_through_at" is null) = ("usage_history_state"."banked_through_id" is null));
-- Banked-through watermark (issue #275): `backfill` records the (created_at, id) through which every
-- usage_records row has a non-pending contribution, so `coverage`'s `pending` check can scan only
-- the rows after it. Both columns NULL = no proof yet = scan everything (the pre-0038 behaviour).
ALTER TABLE "usage_history_state" ADD COLUMN "banked_through_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_history_state" ADD COLUMN "banked_through_id" uuid;
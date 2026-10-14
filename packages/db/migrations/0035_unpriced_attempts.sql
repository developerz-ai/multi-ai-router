ALTER TABLE "usage_attempt_daily_v2" ADD COLUMN "unpriced_attempts" bigint;--> statement-breakpoint
ALTER TABLE "usage_history_state" ADD COLUMN "unpriced_since" date;--> statement-breakpoint
-- The state row is created lazily by the history lock and 0030 never seeds it, so an UPDATE alone
-- would leave a fresh install without a row and without a `since`. The day after the migration
-- runs is the first fully measured day; pre-existing rows stay NULL and are never back-filled.
INSERT INTO "usage_history_state" ("id", "unpriced_since", "updated_at")
VALUES ('v2', ((clock_timestamp() AT TIME ZONE 'UTC')::date + 1), now())
ON CONFLICT ("id") DO UPDATE
SET "unpriced_since" = EXCLUDED."unpriced_since", "updated_at" = EXCLUDED."updated_at";

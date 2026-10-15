-- Weekly usage report (issue #227): the task that builds it and the table that stores it.
--
-- `usage_weekly_report` is a new `scheduled_task` value. It is one-way (a Postgres enum value
-- cannot be removed); an older image reading a run row under the new name is covered by
-- apps/api/test/integration/removed-task-name-rollback.test.ts. `IF NOT EXISTS`, so a re-run of
-- this migration is a no-op like every other one.
--
-- `usage_reports` holds one row per UTC Monday-to-Monday week. `period_start` is unique: it is
-- the idempotency key for `INSERT ... ON CONFLICT (period_start) DO NOTHING`, so two generations
-- that bypass the advisory lock still leave one row. `delivery_status` is `text` (typed against a
-- core union), not a Postgres enum, so delivery (#229) never needs a second one-way enum.
ALTER TYPE "public"."scheduled_task" ADD VALUE IF NOT EXISTS 'usage_weekly_report';--> statement-breakpoint
CREATE TABLE "usage_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"delivery_attempts" integer DEFAULT 0 NOT NULL,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "usage_reports_period_start_unique" UNIQUE("period_start")
);

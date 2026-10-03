ALTER TABLE "quota_windows" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quota_windows" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quota_windows" ADD CONSTRAINT "quota_windows_revision_nonnegative" CHECK ("quota_windows"."revision" >= 0);
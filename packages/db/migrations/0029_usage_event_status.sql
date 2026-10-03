ALTER TABLE "usage_records" ALTER COLUMN "model" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "response_status" smallint;
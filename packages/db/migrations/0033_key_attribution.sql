CREATE TYPE "public"."key_owner_kind" AS ENUM('person', 'service');--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "owner" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "owner_kind" "key_owner_kind";--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "tool" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "purpose" text;
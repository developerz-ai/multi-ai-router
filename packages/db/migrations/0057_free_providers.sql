-- `IF NOT EXISTS` added by hand, so replaying this file over a schema that has the value is a no-op.
-- The two pinned free lanes: the Kilo gateway (keyless) and NVIDIA's hosted NIM endpoints.
ALTER TYPE "public"."provider_id" ADD VALUE IF NOT EXISTS 'kilo' BEFORE 'opencode-go';--> statement-breakpoint
ALTER TYPE "public"."provider_id" ADD VALUE IF NOT EXISTS 'nvidia' BEFORE 'opencode-go';

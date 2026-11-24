-- `IF NOT EXISTS` added by hand throughout, so replaying this file over a schema that has it is a no-op.
-- Its own statement: a new enum value cannot be used in the transaction block that adds it.
ALTER TYPE "public"."scheduled_task" ADD VALUE IF NOT EXISTS 'egress_proxy_check';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_egress_health" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"assignment" text NOT NULL,
	"last_outcome" text,
	"last_status" integer,
	"latency_ms" integer,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"repair" text DEFAULT 'idle' NOT NULL,
	"last_swap_at" timestamp with time zone,
	"swaps" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_egress_health_outcome_known" CHECK ("account_egress_health"."last_outcome" in ('ok', 'auth', 'unreachable', 'timeout', 'refused', 'not_listed', 'vendor_invalid')),
	CONSTRAINT "account_egress_health_failures_nonnegative" CHECK ("account_egress_health"."consecutive_failures" >= 0),
	CONSTRAINT "account_egress_health_repair_known" CHECK ("account_egress_health"."repair" in ('idle', 'cooldown', 'no_candidate', 'vendor_unavailable')),
	CONSTRAINT "account_egress_health_swaps_nonnegative" CHECK ("account_egress_health"."swaps" >= 0)
);
--> statement-breakpoint
ALTER TABLE "account_egress_health" DROP CONSTRAINT IF EXISTS "account_egress_health_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "account_egress_health" ADD CONSTRAINT "account_egress_health_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
CREATE TABLE "usage_attempt_daily_v2" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"api_key_id" uuid,
	"account_id" uuid,
	"pool_id" uuid,
	"model" text,
	"basis" text NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"errors" bigint DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_metered" numeric(24, 6) DEFAULT '0' NOT NULL,
	"cost_notional" numeric(24, 6) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_attempt_daily_v2_grain" UNIQUE NULLS NOT DISTINCT("day","api_key_id","account_id","pool_id","model","basis")
);
--> statement-breakpoint
CREATE TABLE "usage_request_daily_v2" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"api_key_id" uuid,
	"account_id" uuid,
	"pool_id" uuid,
	"model" text,
	"basis" text NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"errors" bigint DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_metered" numeric(24, 6) DEFAULT '0' NOT NULL,
	"cost_notional" numeric(24, 6) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_request_daily_v2_grain" UNIQUE NULLS NOT DISTINCT("day","api_key_id","account_id","pool_id","model","basis")
);
--> statement-breakpoint
CREATE TABLE "usage_contributions" (
	"id" uuid NOT NULL,
	"kind" text NOT NULL,
	"day" date NOT NULL,
	"source" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_contributions_kind_id_pk" PRIMARY KEY("kind","id")
);
--> statement-breakpoint
CREATE TABLE "usage_history_state" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"retention_before_day" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_request_terminals" (
	"correlation_id" uuid PRIMARY KEY NOT NULL,
	"winner_event_id" uuid,
	"api_key_id" uuid,
	"account_id" uuid,
	"pool_id" uuid,
	"provider" "provider_id",
	"model" text,
	"upstream_model" text,
	"outcome" text NOT NULL,
	"error_class" text,
	"response_status" smallint,
	"http_status" smallint,
	"attribution_kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_records" DROP CONSTRAINT "usage_records_api_key_id_api_keys_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_records" DROP CONSTRAINT "usage_records_account_id_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "usage_records" DROP CONSTRAINT "usage_records_pool_id_pools_id_fk";
--> statement-breakpoint
DROP INDEX "price_overrides_provider_model_key";--> statement-breakpoint
ALTER TABLE "price_overrides" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "ingested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "usage_contributions_day_idx" ON "usage_contributions" USING btree ("day");--> statement-breakpoint
CREATE INDEX "usage_contributions_source_idx" ON "usage_contributions" USING btree ("source","id");--> statement-breakpoint
CREATE INDEX "usage_request_terminals_settled_idx" ON "usage_request_terminals" USING btree ("settled_at");--> statement-breakpoint
ALTER TABLE "price_overrides" ADD CONSTRAINT "price_overrides_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_overrides" ADD CONSTRAINT "price_overrides_account_provider_model_key" UNIQUE NULLS NOT DISTINCT("account_id","provider","model");
--> statement-breakpoint
ALTER TABLE "usage_records" ALTER COLUMN "ingested_at" SET DEFAULT clock_timestamp();
--> statement-breakpoint
CREATE FUNCTION usage_history_seal_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION 'legacy usage baseline is sealed';
  END IF;
  IF EXISTS (SELECT 1 FROM usage_history_state WHERE id = 'v2' AND OLD.day < retention_before_day) THEN
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER usage_history_baseline_seal BEFORE INSERT OR UPDATE OR DELETE ON usage_daily
FOR EACH ROW EXECUTE FUNCTION usage_history_seal_baseline();
--> statement-breakpoint
CREATE FUNCTION usage_history_guard_raw_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM usage_contributions WHERE kind = 'attempt' AND id = OLD.id AND source <> 'legacy_pending')
    OR EXISTS (SELECT 1 FROM usage_history_state WHERE id = 'v2' AND (OLD.created_at AT TIME ZONE 'UTC')::date < retention_before_day) THEN
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER usage_history_raw_delete_guard BEFORE DELETE ON usage_records
FOR EACH ROW EXECUTE FUNCTION usage_history_guard_raw_delete();

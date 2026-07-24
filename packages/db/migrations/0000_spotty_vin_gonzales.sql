CREATE TYPE "public"."account_status" AS ENUM('active', 'disabled', 'cooling_down', 'exhausted', 'needs_reauth');--> statement-breakpoint
CREATE TYPE "public"."cost_basis" AS ENUM('metered', 'notional', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."key_scope" AS ENUM('all', 'pools', 'accounts');--> statement-breakpoint
CREATE TYPE "public"."provider_id" AS ENUM('anthropic-oauth', 'anthropic-api', 'openai-oauth', 'openai-api', 'openrouter', 'zai', 'kimi', 'minimax', 'gemini', 'openai-compatible', 'anthropic-compatible');--> statement-breakpoint
CREATE TYPE "public"."reset_source" AS ENUM('provider-reported', 'estimated', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."routing_policy" AS ENUM('sticky', 'round-robin', 'weighted', 'least-used', 'priority-failover', 'quota-aware');--> statement-breakpoint
CREATE TYPE "public"."scheduled_task" AS ENUM('janitor_sweep', 'usage_rollup', 'oauth_state_purge', 'quota_floor_refresh');--> statement-breakpoint
CREATE TYPE "public"."scheduled_task_outcome" AS ENUM('success', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."utilization_source" AS ENUM('continuous', 'threshold-triggered', 'none');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"provider" "provider_id" NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"auth_material" text,
	"config_dir" text,
	"token_expires_at" timestamp with time zone,
	"model_aliases" jsonb,
	"weight" integer DEFAULT 100 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_key_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"prefix" text NOT NULL,
	"scope" "key_scope" DEFAULT 'all' NOT NULL,
	"rate_limit_requests" integer,
	"rate_limit_window_seconds" integer,
	"expires_at" timestamp with time zone,
	"revoked" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text NOT NULL,
	"code_verifier" text NOT NULL,
	"provider" "provider_id" NOT NULL,
	"account_id" uuid,
	"redirect_uri" text,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"weight" integer DEFAULT 100 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"policy" "routing_policy" DEFAULT 'sticky' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quota_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"window" text NOT NULL,
	"utilization" double precision,
	"utilization_source" "utilization_source" DEFAULT 'none' NOT NULL,
	"resets_at" timestamp with time zone,
	"reset_source" "reset_source" DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task" "scheduled_task" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" "scheduled_task_outcome",
	"items_processed" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"api_key_id" uuid NOT NULL,
	"account_id" uuid,
	"sdk_session_id" text,
	"lineage_state" jsonb,
	"fingerprint_source" text,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day" date NOT NULL,
	"api_key_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"model" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_metered" numeric(16, 6) DEFAULT '0' NOT NULL,
	"cost_notional" numeric(16, 6) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correlation_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"api_key_id" uuid,
	"account_id" uuid,
	"provider" "provider_id",
	"session_key" text,
	"model" text NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_estimate" numeric(14, 6),
	"cost_basis" "cost_basis" DEFAULT 'unknown' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"router_overhead_ms" integer DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_key_accounts" ADD CONSTRAINT "api_key_accounts_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_accounts" ADD CONSTRAINT "api_key_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_pools" ADD CONSTRAINT "api_key_pools_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key_pools" ADD CONSTRAINT "api_key_pools_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_members" ADD CONSTRAINT "pool_members_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_members" ADD CONSTRAINT "pool_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quota_windows" ADD CONSTRAINT "quota_windows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_provider_idx" ON "accounts" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "accounts_status_idx" ON "accounts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_config_dir_key" ON "accounts" USING btree ("config_dir");--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_accounts_key_account_key" ON "api_key_accounts" USING btree ("api_key_id","account_id");--> statement-breakpoint
CREATE INDEX "api_key_accounts_account_idx" ON "api_key_accounts" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_pools_key_pool_key" ON "api_key_pools" USING btree ("api_key_id","pool_id");--> statement-breakpoint
CREATE INDEX "api_key_pools_pool_idx" ON "api_key_pools" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "api_keys_prefix_idx" ON "api_keys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_keys_revoked_at_idx" ON "api_keys" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_kind_created_idx" ON "audit_events" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_subject_idx" ON "audit_events" USING btree ("subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_states_state_key" ON "oauth_states" USING btree ("state");--> statement-breakpoint
CREATE INDEX "oauth_states_expires_at_idx" ON "oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pool_members_pool_account_key" ON "pool_members" USING btree ("pool_id","account_id");--> statement-breakpoint
CREATE INDEX "pool_members_account_idx" ON "pool_members" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pools_name_key" ON "pools" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "quota_windows_account_window_key" ON "quota_windows" USING btree ("account_id","window");--> statement-breakpoint
CREATE INDEX "quota_windows_resets_at_idx" ON "quota_windows" USING btree ("resets_at");--> statement-breakpoint
CREATE INDEX "scheduled_task_runs_task_started_idx" ON "scheduled_task_runs" USING btree ("task","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_api_key_key_key" ON "sessions" USING btree ("api_key_id","key");--> statement-breakpoint
CREATE INDEX "sessions_account_idx" ON "sessions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sessions_last_used_at_idx" ON "sessions" USING btree ("last_used_at");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_daily_grain_key" ON "usage_daily" USING btree ("day","api_key_id","account_id","model");--> statement-breakpoint
CREATE INDEX "usage_daily_day_idx" ON "usage_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "usage_daily_account_day_idx" ON "usage_daily" USING btree ("account_id","day");--> statement-breakpoint
CREATE INDEX "usage_records_api_key_created_idx" ON "usage_records" USING btree ("api_key_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_records_account_created_idx" ON "usage_records" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_records_correlation_idx" ON "usage_records" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "usage_records_session_key_idx" ON "usage_records" USING btree ("session_key");--> statement-breakpoint
CREATE INDEX "usage_records_created_at_idx" ON "usage_records" USING btree ("created_at");
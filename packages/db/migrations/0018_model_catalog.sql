-- What each account's upstream says it serves, and how big those models are.
--
-- Deliberately a second table rather than more columns on `accounts`, because it
-- answers a different question than `supported_models` does and must never be
-- confused with it. `supported_models` gates routing and is operator-owned: the
-- note on that column says a catalog refreshed on a timer would change routing
-- without anyone asking, and that stands. This table only *describes* — nothing
-- in selection reads it — so it is free to refresh itself hourly, which is what
-- makes a live catalog listing possible at all.
--
-- Keyed by account, not provider: two accounts of one provider genuinely answer
-- the listing endpoint differently (a coding plan versus the metered API, or two
-- `openai-compatible` accounts pointed at different base URLs), and collapsing
-- them would make five Claude subscriptions share one answer.
--
-- `context_tokens` NULL means unknown, never unlimited and never zero. Verified
-- against the live endpoints before writing this: z.ai, MiniMax, OpenAI and
-- Anthropic all answer `/v1/models` with an id, an object type and an owner and
-- nothing else, so most rows take their window from the shipped table and say so
-- in `context_source`.
ALTER TYPE "public"."scheduled_task" ADD VALUE IF NOT EXISTS 'model_catalog_refresh';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_catalog" (
	"account_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"context_tokens" integer,
	"max_output_tokens" integer,
	"context_source" text,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_catalog_account_id_model_id_pk" PRIMARY KEY("account_id","model_id")
);
--> statement-breakpoint
-- Delete the account and its catalog is not stale, it is meaningless.
ALTER TABLE "model_catalog" DROP CONSTRAINT IF EXISTS "model_catalog_account_id_accounts_id_fk";--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The catalog listing groups every row by model id across accounts.
CREATE INDEX IF NOT EXISTS "model_catalog_model_id_idx" ON "model_catalog" USING btree ("model_id");

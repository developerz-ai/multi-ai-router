DROP INDEX "usage_daily_grain_key";--> statement-breakpoint
ALTER TABLE "usage_daily" ADD COLUMN "pool_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_daily_grain_key" ON "usage_daily" USING btree ("day","api_key_id","account_id",coalesce("pool_id", '00000000-0000-0000-0000-000000000000'::uuid),"model");
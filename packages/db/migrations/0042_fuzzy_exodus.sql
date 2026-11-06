-- Two additions, both additive.
--
-- `model_catalog.reasoning`: what a provider's listing states about a model's thinking modes. NULL on
-- every existing row and for every provider that states nothing; the next catalog sweep fills it.
--
-- `plan_quota_read` is a new `scheduled_task` value. It is one-way (a Postgres enum value cannot be
-- removed); an older image reading a run row under the new name is covered by
-- apps/api/test/integration/removed-task-name-rollback.test.ts.
--
-- Rollback is additive-only: pin the previous image tag. Old binaries ignore the column.
-- `IF NOT EXISTS` is added by hand to what drizzle-kit generates, so a re-run is a no-op.
ALTER TYPE "public"."scheduled_task" ADD VALUE IF NOT EXISTS 'plan_quota_read';--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN IF NOT EXISTS "reasoning" jsonb;

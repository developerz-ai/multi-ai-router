-- Two additions, both additive.
--
-- `accounts.auth_refresh_spent_on`: the fingerprint of the credential whose one parked refresh is
-- spent. NULL on every existing row, which is the point: an OAuth account parked `needs_reauth`
-- before this shipped gets exactly one refresh attempt on the next boot, with no sign-in if its
-- refresh token still works. Compared against the live `auth_material`, so any later credential
-- write ends the spend without knowing this column exists.
--
-- `cooldown_recheck` is a new `scheduled_task` value. It is one-way (a Postgres enum value cannot be
-- removed); an older image reading a run row under the new name is covered by
-- apps/api/test/integration/removed-task-name-rollback.test.ts.
--
-- Rollback is additive-only: pin the previous image tag. Old binaries ignore the column.
-- `IF NOT EXISTS` is added by hand to what drizzle-kit generates, so a re-run is a no-op.
ALTER TYPE "public"."scheduled_task" ADD VALUE IF NOT EXISTS 'cooldown_recheck';--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "auth_refresh_spent_on" text;

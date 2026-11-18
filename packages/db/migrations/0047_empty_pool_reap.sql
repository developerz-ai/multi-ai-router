-- The durable fact the `pool_reap` task reads: when a pool last became memberless.
--
-- `pools.empty_since`: NULL while the pool has a member, the instant it lost its last one otherwise.
-- Kept by a trigger on `pool_members` rather than by the pools service, because membership also
-- drops through `ON DELETE CASCADE` when an account is deleted, a write no service observes. Every
-- write to `pool_members` passes through it: INSERT clears the new row's pool, DELETE marks the old
-- row's pool once no member is left, and UPDATE does both (no code updates `pool_id` today; the
-- membership is replaced as delete-then-insert, which ends with the column cleared). The delete
-- branch takes the pool's row lock before it looks, so concurrent deletions serialize per pool and
-- the last one to commit sees the pool empty (READ COMMITTED: each statement a fresh snapshot).
--
-- The column default is the creation instant: a pool created with no members has been empty since
-- it existed. Existing rows take this migration's instant, then pools holding a member are cleared,
-- so a pool that was already empty waits one full window from the upgrade, never less.
--
-- `pool_reap` is a new `scheduled_task` value. One-way (a Postgres enum value cannot be removed);
-- an older image reading a run row under the new name is covered by
-- apps/api/test/integration/removed-task-name-rollback.test.ts.
--
-- Rollback: pin the previous image. It never selects the column; the trigger keeps working under it.
-- Guarded throughout, so a replay is a no-op.
ALTER TYPE "public"."scheduled_task" ADD VALUE IF NOT EXISTS 'pool_reap';--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN IF NOT EXISTS "empty_since" timestamp with time zone DEFAULT now();--> statement-breakpoint
UPDATE "pools" SET "empty_since" = NULL
WHERE EXISTS (SELECT 1 FROM "pool_members" WHERE "pool_members"."pool_id" = "pools"."id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION pool_members_track_empty() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    -- Lock the pool first, so the membership check below runs in a statement snapshot taken after
    -- every concurrent membership write to this pool has committed. Without it, two transactions
    -- deleting a pool's last two members (two account deletions) each still see the other's row
    -- and both skip the mark, leaving an empty pool that is never reaped.
    PERFORM 1 FROM pools WHERE id = OLD.pool_id FOR UPDATE;
    UPDATE pools SET empty_since = now()
    WHERE id = OLD.pool_id
      AND empty_since IS NULL
      AND NOT EXISTS (SELECT 1 FROM pool_members WHERE pool_id = OLD.pool_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE pools SET empty_since = NULL WHERE id = NEW.pool_id AND empty_since IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS pool_members_track_empty ON pool_members;--> statement-breakpoint
CREATE TRIGGER pool_members_track_empty AFTER INSERT OR UPDATE OR DELETE ON pool_members
FOR EACH ROW EXECUTE FUNCTION pool_members_track_empty();

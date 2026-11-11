-- Key names are unique (plan 101, 08.10). The admin service has always refused a duplicate under an
-- advisory lock; this makes it hold for every writer (`bin/admin`, hand SQL, a future path), and
-- turns `findByName` from a sequential scan into an index probe.
--
-- Verified before shipping: both production databases hold no duplicate name. Should an install
-- have one anyway, the guard below fails the boot with a message naming the duplicates and the fix
-- (SQLSTATE MR001, surfaced by `runMigrations` as `MigrationPreconditionError`) instead of an
-- anonymous unique violation from the index build. Nothing is renamed automatically: which key
-- keeps the name is the operator's call.
--
-- `api_keys` is tens of rows: the build's SHARE lock is momentary. Guarded, so a replay is a no-op.
-- Rollback: pin the previous image; old binaries already refuse duplicates in the service.
DO $$
DECLARE
  duplicated text;
BEGIN
  SELECT string_agg(format('%L (%s keys)', name, n), ', ' ORDER BY name)
    INTO duplicated
    FROM (SELECT name, count(*) AS n FROM api_keys GROUP BY name HAVING count(*) > 1) d;
  IF duplicated IS NOT NULL THEN
    RAISE EXCEPTION 'api_keys has duplicate names: %. Rename all but one of each (console or bin/admin), then restart.', duplicated
      USING ERRCODE = 'MR001';
  END IF;
END
$$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_name_key" ON "api_keys" USING btree ("name");

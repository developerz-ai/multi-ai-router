-- A pool-scoped key's candidates are "the union, in the listed order"
-- (04-api-keys-and-access.md), and selection honors the order it is given —
-- but nothing stored it. A scope write deletes and re-inserts the rows, and
-- the planner reading them back through the unique `(api_key_id, pool_id)`
-- index returns pool-id order, silently turning a key's primary pool into
-- its fallback. This column makes the listed order a fact of the schema.
--
-- `DEFAULT 0`, not no default: the previous release image's INSERT omits the
-- column, and it must keep landing — an upgrade followed by a rollback must
-- not turn every scope write into a failure. Such rows all tie at 0 and fall
-- back to id order, which degrades ordering without breaking anything.
--
-- The backfill numbers each key's rows in their *physical* order, because
-- that is what reads return today: rows from one multi-row INSERT share
-- `created_at`, so only `ctid` recovers the order the scope was listed in.
ALTER TABLE "api_key_pools" ADD COLUMN IF NOT EXISTS "position" integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE "api_key_pools" AS akp
SET "position" = numbered."position"
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "api_key_id" ORDER BY "ctid") AS "position"
  FROM "api_key_pools"
) AS numbered
WHERE akp."id" = numbered."id";

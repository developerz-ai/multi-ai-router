-- The overflow account must be one of the pool's members.
--
-- Candidates are `pool_members ∩ key_scope` and nothing widens that (CLAUDE.md
-- non-negotiable 6). Until now `pools.overflow_account_id` could name any
-- account at all, so a key scoped to pool `team-a` reached that pool's overflow
-- the moment every member cooled down — an account it never named, whose models
-- `/v1/models` advertised besides. Routing now honors an overflow only when it
-- is also a membership, and the admin plane refuses to write one that is not.
--
-- This backfills the rows written before that rule. It adds the missing
-- membership rather than clearing the reference: routing behavior is unchanged
-- (the designated member is still held back from the policy and engaged only
-- once every other member has filtered out), while the reach an operator
-- already granted stops being invisible and starts showing up in the pool's
-- member list, where it can be reviewed and removed. Clearing the reference
-- instead would silently delete a paid fallback and turn an upgrade into an
-- outage at the next spike.
--
-- Idempotent: the anti-join is a no-op on a second run, and a pool whose
-- overflow is already a member is untouched.
INSERT INTO "pool_members" ("pool_id", "account_id")
SELECT "pools"."id", "pools"."overflow_account_id"
FROM "pools"
WHERE "pools"."overflow_account_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "pool_members"
    WHERE "pool_members"."pool_id" = "pools"."id"
      AND "pool_members"."account_id" = "pools"."overflow_account_id"
  );

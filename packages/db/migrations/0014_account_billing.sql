-- How an account is billed, which is the only input to how its usage is priced.
--
-- Until now "is this a subscription" was answered by a hardcoded two-element
-- provider set inside the cost estimator. That set is right about the two
-- providers sold *only* as a subscription and wrong about every other one: z.ai,
-- Kimi and MiniMax each sell a flat-fee coding plan under the same endpoint and
-- the same key shape as their metered API, and no request the router can make
-- tells them apart. Only the operator knows which was bought, so it is recorded
-- against the account.
CREATE TYPE "public"."account_billing" AS ENUM('metered', 'subscription');--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "billing" "account_billing" DEFAULT 'metered' NOT NULL;--> statement-breakpoint
-- Behavior-preserving backfill: these two providers are exactly the set the
-- estimator hardcoded, so every existing row keeps the basis it was already
-- reported under.
--
-- Nothing else moves, and `metered` is the right default even though it is
-- sometimes wrong: an operator's coding-plan account now prices as ordinary
-- metered spend — the vendor tables shipped alongside this migration cover
-- z.ai, Kimi and MiniMax — until they mark it a subscription. Guessing the
-- other way would restate a per-token bill nobody was issued as a flat fee
-- nobody agreed to, for every metered account of those providers at once.
--
-- Idempotent: a re-run sets those two providers' rows to the value they hold.
UPDATE "accounts"
SET "billing" = 'subscription'
WHERE "provider" IN ('anthropic-oauth', 'openai-oauth');

-- Two more facts per model_catalog row, so a Claude subscription can have a
-- catalog at all (apps/api/src/providers/claude-sdk/model-list.ts).
--
-- A subscription has no HTTP model listing to GET, so until now its rows were
-- never written and `GET /v1/models` on a pool of subscriptions answered
-- `data: []`. The Agent SDK's `system/init` handshake is the sanctioned live
-- voice for what one subscription serves — aliases such as `sonnet` included,
-- each with the canonical id it resolves to today — and when that voice is
-- unavailable the shipped table stands in. Both need a label a reader can
-- judge, hence `listing_source` (`upstream` | `live` | `shipped`); an alias row
-- needs somewhere to say what it resolves to, hence `resolved_model`.
--
-- `listing_source` defaults to `upstream` because every row written before this
-- column existed came from a provider's own HTTP listing. `text` rather than an
-- enum, by the same rule `context_source` follows: a label that only describes
-- a reading must not need a migration to learn a new value. `IF NOT EXISTS`, so
-- a re-run is a no-op like every other migration here.
ALTER TABLE "model_catalog" ADD COLUMN IF NOT EXISTS "listing_source" text DEFAULT 'upstream' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN IF NOT EXISTS "resolved_model" text;

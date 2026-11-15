-- An account's standing `provider` routing preferences (OpenRouter's request field: `sort`,
-- `quantizations`, `allow_fallbacks`, `order`, `only`, `ignore`, `require_parameters`), merged into
-- every request it is sent. Validated at the admin write, never here: NULL is "none", and every
-- existing row is NULL, so nothing any account is sent changes until an operator sets one.
--
-- A nullable column with no default: a catalog-only change on PostgreSQL, no table rewrite.
-- Guarded, so a replay is a no-op. Rollback: pin the previous image; it never selects the column.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "provider_preferences" jsonb;

-- The ids recently removed from `supported_models`, with when and by whom, so a request refused
-- `model-unsupported` for one of them can name the edit that caused it (prod 2026-11-15: a
-- "Discover models" overwrite dropped a hand-added id and ~320 tasks failed over 19 h before
-- anyone connected the refusals to the edit). Nullable and read by nothing that admits or
-- excludes an account, so an older image that never reads it is unaffected.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "supported_models_removed" jsonb;

-- Usage counts: missing is NULL, never zero; and the reasoning count gets a column.
--
-- The four token columns were `NOT NULL DEFAULT 0` while the spec said a count the upstream never
-- stated is null (docs/idea/06-protocol-translation.md, "Absent, never zero"): a Codex stream that
-- stated no usage was stored as four measured zeros. NOT NULL and the default both go, so an insert
-- that leaves a count out stores NULL rather than inventing 0. Existing rows keep their values;
-- nothing is backfilled, because a pre-0048 zero cannot be told apart from a measured one.
--
-- `reasoning_tokens`: the part of `tokens_out` an OpenAI-dialect upstream states it spent
-- reasoning. NULL when unstated (every Anthropic upstream, every earlier row). A GPT model behind
-- the Anthropic wire had nowhere to put it: the Anthropic answer has no such field.
--
-- Backward-safe: every statement is catalog-only (no rewrite, no scan) and one ALTER takes the
-- table lock once. An older image always writes all four counts explicitly and never selects
-- `reasoning_tokens`, so rollback is pinning the previous image; this migration needs no undo.
-- Guarded, so a replay is a no-op.
ALTER TABLE "usage_records"
  ALTER COLUMN "tokens_in" DROP DEFAULT,
  ALTER COLUMN "tokens_in" DROP NOT NULL,
  ALTER COLUMN "tokens_out" DROP DEFAULT,
  ALTER COLUMN "tokens_out" DROP NOT NULL,
  ALTER COLUMN "cache_read_tokens" DROP DEFAULT,
  ALTER COLUMN "cache_read_tokens" DROP NOT NULL,
  ALTER COLUMN "cache_write_tokens" DROP DEFAULT,
  ALTER COLUMN "cache_write_tokens" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "reasoning_tokens" integer;

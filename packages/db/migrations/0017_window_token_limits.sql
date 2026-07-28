-- Operator-set token ceilings per quota window, keyed by QuotaWindowKind.
--
-- A number the operator chose, never one the provider stated: Anthropic publishes
-- no numeric limit and its SDK reports a utilization only near a window's edge, so
-- for most of every window the console has nothing to draw. A ceiling here lets it
-- show consumption the router measured itself against a figure the operator owns.
--
-- Read by the console only. Nothing in routing consults it — a guess about someone
-- else's accounting must not decide which account serves a request.
ALTER TABLE "accounts" ADD COLUMN "window_token_limits" jsonb;
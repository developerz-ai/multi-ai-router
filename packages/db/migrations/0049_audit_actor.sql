-- Who made each change: the caller the recorder stamps on every audit row (multi-ai-router#453).
--
-- `actor` is the session's username (the SSO email), `admin-api-token`, `system` for a scheduled
-- task, or `unknown` when a write reached the recorder with no caller; `actor_kind` says which
-- (`session` | `api_token` | `system` | `unattributed`). `actor_says` is the caller's self-declared
-- `X-Admin-Actor` (redacted, capped, never authentication) or the scheduled task's name.
-- `client_ip` is resolved under TRUST_PROXY / TRUST_PROXY_HOPS like the login throttle's;
-- `user_agent` is capped; `request_id` joins the row to its request log lines.
--
-- All nullable, no default, nothing backfilled: a row written before this migration names no
-- caller, and inventing one would be the audit log lying. The index answers "everything this caller
-- changed", newest first.
--
-- Backward-safe: the ADD COLUMNs are catalog-only (no rewrite). The index build scans the table
-- once under a write lock; audit_events is admin-plane only and bounded by RETENTION_AUDIT_DAYS, and
-- no data-plane request writes it. Rollback is pinning the previous image (2.66.0): it never selects
-- these columns and its inserts leave them NULL. Guarded, so a replay is a no-op.
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "actor" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "actor_kind" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "actor_says" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "client_ip" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "user_agent" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN IF NOT EXISTS "request_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_actor_created_idx" ON "audit_events" USING btree ("actor","created_at");

-- Two scheduled tasks for a Claude subscription's two credential clocks.
--
-- `credential_keepalive` runs the existing keepalive turn on the cadence the
-- *access* token needs: every few minutes it reads each logged-in
-- subscription's credential metadata (timestamps only) and, for the ones
-- inside the `claude` CLI's own five-minute refresh lead, spends one small
-- real turn so the CLI refreshes before the token lapses
-- (apps/api/src/scheduler/tasks/credential-keepalive.ts).
--
-- `login_lifetime_watch` writes one structured warn line per day for every
-- subscription whose *login* (the ~28-day refresh token, which only an
-- interactive re-login moves) is inside the warn window
-- (apps/api/src/scheduler/tasks/login-lifetime-watch.ts).
--
-- `IF NOT EXISTS`, so a re-run of this migration is a no-op like every other one.
ALTER TYPE "public"."scheduled_task" ADD VALUE IF NOT EXISTS 'credential_keepalive';--> statement-breakpoint
ALTER TYPE "public"."scheduled_task" ADD VALUE IF NOT EXISTS 'login_lifetime_watch';

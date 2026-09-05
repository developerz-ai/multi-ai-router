-- Admin console sessions, made durable (packages/db/src/schema/admin-sessions.ts).
--
-- Until now the console's sessions lived in one process's heap, so every
-- restart or redeploy logged the operator out. This table holds one row per
-- live session, keyed by the SHA-256 of the opaque cookie id — never the id
-- itself, so a dump of this table cannot be turned into a cookie. The CSRF
-- token is stored as-is: the SPA reads it back on every session read and it
-- is useless without the cookie the table refuses to hold. Both expiry bounds
-- are indexed because the purge (apps/api/src/scheduler/tasks/admin-session-
-- purge.ts) deletes on whichever of the two has passed.
CREATE TABLE "admin_sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"csrf_token" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"idle_expiry_at" timestamp with time zone NOT NULL,
	"absolute_expiry_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "admin_sessions_idle_expiry_at_idx" ON "admin_sessions" USING btree ("idle_expiry_at");--> statement-breakpoint
CREATE INDEX "admin_sessions_absolute_expiry_at_idx" ON "admin_sessions" USING btree ("absolute_expiry_at");
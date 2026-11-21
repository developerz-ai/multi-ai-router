CREATE TABLE IF NOT EXISTS "admin_login_throttle_namespaces" (
  "namespace" text PRIMARY KEY NOT NULL,
  "swept_at" timestamp with time zone NOT NULL,
  "saturation_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_login_throttle_buckets" (
  "namespace" text NOT NULL,
  "key" text NOT NULL,
  "attempts" integer NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "locked" boolean NOT NULL,
  "denial_reported" boolean NOT NULL,
  CONSTRAINT "admin_login_throttle_buckets_namespace_key_pk" PRIMARY KEY("namespace", "key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_login_throttle_expiry_idx" ON "admin_login_throttle_buckets" ("namespace", "expires_at");
--> statement-breakpoint
INSERT INTO "admin_login_throttle_namespaces" VALUES
  ('local', 'epoch', 'epoch'),
  ('oidc-start', 'epoch', 'epoch'),
  ('oidc-callback', 'epoch', 'epoch')
ON CONFLICT ("namespace") DO NOTHING;

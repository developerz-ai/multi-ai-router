CREATE TABLE IF NOT EXISTS "account_breakers" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL DEFAULT 0,
  "lifecycle_version" integer NOT NULL,
  "health_recovery_version" integer NOT NULL,
  "auth_recovery_version" integer NOT NULL,
  "credential_fingerprint" text NOT NULL,
  "status" "account_status" NOT NULL,
  "cooldown_until" timestamptz,
  "cooldown_source" "reset_source" NOT NULL,
  "cooldown_reason" text,
  "consecutive_failures" integer NOT NULL,
  "probe_held_until" timestamptz,
  "captured_generation" uuid,
  CONSTRAINT "account_breakers_counts_valid" CHECK (revision >= 0 AND consecutive_failures >= 0 AND lifecycle_version >= 0 AND health_recovery_version >= 0 AND auth_recovery_version >= 0),
  CONSTRAINT "account_breakers_clock_valid" CHECK ((status = 'cooling_down' AND cooldown_until IS NOT NULL) OR (status <> 'cooling_down' AND cooldown_until IS NULL)),
  CONSTRAINT "account_breakers_reason_valid" CHECK (cooldown_reason IS NULL OR (cooldown_reason = 'credential-rejected' AND status = 'cooling_down')),
  CONSTRAINT "account_breakers_probe_hold_valid" CHECK (probe_held_until IS NULL OR status = 'cooling_down')
);

CREATE TABLE IF NOT EXISTS account_pending_claude_logins (
  account_id uuid PRIMARY KEY,
  owner uuid NOT NULL,
  generation bigint NOT NULL CONSTRAINT account_pending_claude_logins_generation CHECK (generation > 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint

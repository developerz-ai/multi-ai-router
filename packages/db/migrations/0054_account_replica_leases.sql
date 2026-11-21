CREATE TABLE IF NOT EXISTS account_replica_leases (
  account_id uuid PRIMARY KEY,
  owner uuid NOT NULL,
  generation bigint NOT NULL CONSTRAINT account_replica_leases_generation CHECK (generation > 0),
  expires_at timestamptz NOT NULL,
  storage_identity text CONSTRAINT account_replica_leases_storage CHECK (storage_identity IS NULL OR length(storage_identity) BETWEEN 1 AND 512),
  state text NOT NULL CONSTRAINT account_replica_leases_state CHECK (state IN ('attaching', 'ready', 'draining', 'released')),
  CONSTRAINT account_replica_leases_ready CHECK (state <> 'ready' OR storage_identity IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS account_replica_leases_expiry_idx ON account_replica_leases (expires_at);

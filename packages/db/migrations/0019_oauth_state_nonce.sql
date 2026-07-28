-- Admin OIDC start flow carries a `nonce` alongside the existing PKCE verifier.
-- The same `oauth_states` table is reused — the column is nullable because the
-- account-connect flow that already uses this table does not mint a nonce.
-- The nonce is stored ciphertext, not plaintext, like the existing
-- `code_verifier`. `accounts.id` is not required, so the existing FK to
-- `accounts` is left untouched; the admin row leaves `account_id` null.
ALTER TABLE "oauth_states" ADD COLUMN IF NOT EXISTS "nonce" text;--> statement-breakpoint

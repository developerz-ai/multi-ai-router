CREATE TABLE "account_recoveries" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"generation" uuid NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"lifecycle_version" integer NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"owner_boot_id" uuid,
	"ownership_epoch" integer DEFAULT 0 NOT NULL,
	"preparation_lease_until" timestamp with time zone,
	"permit_id" uuid,
	"issued_at" timestamp with time zone,
	"outcome_at" timestamp with time zone,
	"requested_at" timestamp with time zone NOT NULL,
	"next_allowed_at" timestamp with time zone NOT NULL,
	"quota_revisions" jsonb NOT NULL,
	CONSTRAINT "account_recoveries_revision_nonnegative" CHECK ("account_recoveries"."revision" >= 0),
	CONSTRAINT "account_recoveries_epoch_nonnegative" CHECK ("account_recoveries"."ownership_epoch" >= 0),
	CONSTRAINT "account_recoveries_state_valid" CHECK ("account_recoveries"."state" in ('pending','issued','succeeded','failed','uncertain','cancelled')),
	CONSTRAINT "account_recoveries_permit_valid" CHECK (("account_recoveries"."state" = 'pending' and "account_recoveries"."permit_id" is null and "account_recoveries"."issued_at" is null) or ("account_recoveries"."state" in ('issued','succeeded','failed','uncertain') and "account_recoveries"."permit_id" is not null and "account_recoveries"."issued_at" is not null and "account_recoveries"."owner_boot_id" is not null) or "account_recoveries"."state" = 'cancelled')
);
--> statement-breakpoint
ALTER TABLE "quota_windows" ADD COLUMN "evidence_state" text DEFAULT 'current' NOT NULL;--> statement-breakpoint
ALTER TABLE "quota_windows" ADD COLUMN "blocks_routing" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "account_recoveries" ADD CONSTRAINT "account_recoveries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
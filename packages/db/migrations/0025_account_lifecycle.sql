ALTER TABLE "accounts" ADD COLUMN "lifecycle_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "health_recovery_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "auth_recovery_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "authorization_attempt_id" uuid;
--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "authorization_lifecycle_version" integer;
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_lifecycle_version_nonnegative" CHECK ("accounts"."lifecycle_version" >= 0);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_health_recovery_version_nonnegative" CHECK ("accounts"."health_recovery_version" >= 0);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_auth_recovery_version_nonnegative" CHECK ("accounts"."auth_recovery_version" >= 0);

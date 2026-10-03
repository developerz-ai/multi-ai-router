CREATE TABLE "account_operator_checks" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"claim_token" uuid NOT NULL,
	"lease_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_operator_checks" ADD CONSTRAINT "account_operator_checks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
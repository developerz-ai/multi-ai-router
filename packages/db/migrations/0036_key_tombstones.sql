CREATE TABLE "api_key_tombstones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"owner" text,
	"owner_kind" "key_owner_kind",
	"tool" text,
	"purged_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "api_key_tombstones_purged_at_idx" ON "api_key_tombstones" USING btree ("purged_at");
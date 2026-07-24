ALTER TABLE "usage_records" ADD COLUMN "client_request_id" text;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "pool_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "upstream_model" text;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "ingress_dialect" text;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "egress_mode" text;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "ttfb_ms" integer;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "streamed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "http_status" integer;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "error_class" text;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_pool_id_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_records_client_request_idx" ON "usage_records" USING btree ("client_request_id") WHERE "usage_records"."client_request_id" is not null;
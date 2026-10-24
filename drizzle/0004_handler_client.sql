CREATE TYPE "public"."handler_client" AS ENUM('nucleus', 'partydeck');--> statement-breakpoint
ALTER TABLE "handlers" ADD COLUMN "client" "handler_client" DEFAULT 'nucleus' NOT NULL;--> statement-breakpoint
CREATE INDEX "handlers_client_idx" ON "handlers" USING btree ("client");
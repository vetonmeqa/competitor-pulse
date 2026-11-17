DROP INDEX "competitors_next_poll_at_idx";--> statement-breakpoint
ALTER TABLE "competitors" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "competitors_next_poll_at_idx" ON "competitors" USING btree ("next_poll_at") WHERE "competitors"."paused_at" IS NULL;
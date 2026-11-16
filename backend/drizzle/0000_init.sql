CREATE TYPE "public"."availability" AS ENUM('unknown', 'listed', 'delisted');--> statement-breakpoint
CREATE TYPE "public"."change_kind" AS ENUM('initial', 'content', 'revert', 'delisted', 'relisted');--> statement-breakpoint
CREATE TYPE "public"."poll_status" AS ENUM('ok', 'not_found', 'incomplete', 'error');--> statement-breakpoint
CREATE TYPE "public"."summary_source" AS ENUM('llm', 'template');--> statement-breakpoint
CREATE TYPE "public"."summary_status" AS ENUM('none', 'pending', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"availability" "availability" DEFAULT 'unknown' NOT NULL,
	"current_version_id" bigint,
	"previous_version_id" bigint,
	"last_polled_at" timestamp with time zone,
	"last_poll_status" "poll_status",
	"last_changed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "listing_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "listing_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"competitor_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"title" text NOT NULL,
	"tagline" text NOT NULL,
	"price" text NOT NULL,
	"description" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"competitor_id" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"status" "poll_status" NOT NULL,
	"failure_reason" text,
	"version_id" bigint,
	"prev_version_id" bigint,
	"changed" boolean DEFAULT false NOT NULL,
	"change_kind" "change_kind",
	"summary" text,
	"summary_status" "summary_status" DEFAULT 'none' NOT NULL,
	"summary_source" "summary_source",
	"summary_error" text,
	"summary_attempts" integer DEFAULT 0 NOT NULL,
	"summary_next_attempt_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_current_version_id_listing_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."listing_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_previous_version_id_listing_versions_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."listing_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_versions" ADD CONSTRAINT "listing_versions_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_version_id_listing_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."listing_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_prev_version_id_listing_versions_id_fk" FOREIGN KEY ("prev_version_id") REFERENCES "public"."listing_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitors_next_poll_at_idx" ON "competitors" USING btree ("next_poll_at");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_versions_competitor_hash_uq" ON "listing_versions" USING btree ("competitor_id","content_hash");--> statement-breakpoint
CREATE INDEX "snapshots_competitor_fetched_idx" ON "snapshots" USING btree ("competitor_id","fetched_at","id");--> statement-breakpoint
CREATE INDEX "snapshots_pending_summary_idx" ON "snapshots" USING btree ("fetched_at") WHERE "snapshots"."summary_status" = 'pending';--> statement-breakpoint
CREATE INDEX "snapshots_fetched_at_brin" ON "snapshots" USING brin ("fetched_at");
CREATE TABLE "worker_status" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"report" jsonb NOT NULL,
	CONSTRAINT "worker_status_single_row" CHECK ("worker_status"."id" = 1)
);

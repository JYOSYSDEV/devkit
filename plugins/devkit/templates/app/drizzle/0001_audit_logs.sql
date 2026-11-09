CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"target" text,
	"request_id" text,
	"window_start" timestamp with time zone,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_logs_denied_window_key" ON "audit_logs" USING btree ("actor_id","action","window_start");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");
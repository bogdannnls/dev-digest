CREATE TABLE "eval_run_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"owner_kind" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_version" integer,
	"system_prompt" text NOT NULL,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"cases_total" integer NOT NULL,
	"traces_passed" integer DEFAULT 0 NOT NULL,
	"recall" double precision,
	"precision" double precision,
	"citation_accuracy" double precision,
	"duration_ms" integer,
	"cost_usd" double precision,
	"tokens_in" integer,
	"tokens_out" integer,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "batch_id" uuid REFERENCES "eval_run_batches"("id") ON DELETE CASCADE;

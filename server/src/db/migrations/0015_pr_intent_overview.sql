ALTER TABLE "pr_intent"
  ADD COLUMN "head_sha"          text          NOT NULL DEFAULT '',
  ADD COLUMN "body_hash"         text          NOT NULL DEFAULT '',
  ADD COLUMN "references"        jsonb         NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "risk_areas"        jsonb         NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "model"             text,
  ADD COLUMN "prompt_tokens"     integer       NOT NULL DEFAULT 0,
  ADD COLUMN "completion_tokens" integer       NOT NULL DEFAULT 0,
  ADD COLUMN "cost_usd"          numeric(10,6) NOT NULL DEFAULT 0,
  ADD COLUMN "computed_at"       timestamptz   NOT NULL DEFAULT now();
--> statement-breakpoint
-- Freshness columns are populated on every write; defaults exist only to
-- back-fill zero existing rows.
ALTER TABLE "pr_intent"
  ALTER COLUMN "head_sha" DROP DEFAULT,
  ALTER COLUMN "body_hash" DROP DEFAULT;

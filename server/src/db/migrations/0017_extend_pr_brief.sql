ALTER TABLE "pr_brief"
  ADD COLUMN "head_sha"           text          NOT NULL DEFAULT '',
  ADD COLUMN "review_id"          uuid REFERENCES "reviews"("id") ON DELETE SET NULL,
  ADD COLUMN "intent_computed_at" timestamptz   NOT NULL DEFAULT now(),
  ADD COLUMN "risk_level"         text          NOT NULL DEFAULT '',
  ADD COLUMN "model"              text,
  ADD COLUMN "prompt_tokens"      integer       NOT NULL DEFAULT 0,
  ADD COLUMN "completion_tokens"  integer       NOT NULL DEFAULT 0,
  ADD COLUMN "cost_usd"           numeric(10,6) NOT NULL DEFAULT 0,
  ADD COLUMN "computed_at"        timestamptz   NOT NULL DEFAULT now();
--> statement-breakpoint
-- Freshness/identity columns are populated on every write; the temporary
-- defaults above exist only to back-fill zero existing rows (pr_brief has
-- had no consumer to date), mirroring 0015_pr_intent_overview.sql.
ALTER TABLE "pr_brief"
  ALTER COLUMN "head_sha" DROP DEFAULT,
  ALTER COLUMN "intent_computed_at" DROP DEFAULT,
  ALTER COLUMN "risk_level" DROP DEFAULT;

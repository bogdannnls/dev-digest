ALTER TABLE "conventions"
  ADD COLUMN "category" text NOT NULL DEFAULT 'general',
  ADD COLUMN "created_at" timestamptz NOT NULL DEFAULT now();

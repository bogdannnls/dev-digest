import type { FeatureModelDef } from "./types";

/**
 * Client-local copy of the per-feature model registry.
 *
 * The server's source of truth is `FEATURE_MODELS` in `@devdigest/shared`, but
 * the client can only import TYPES from the vendored shared package — importing
 * a runtime VALUE pulls `vendor/shared/index.ts` into the webpack bundle, whose
 * `./contracts/*.js` re-exports Next's webpack can't resolve. So we mirror the
 * registry here (same pattern as the vendored `vendor/shared` / `vendor/ui`).
 * Keep this in sync with the shared registry.
 */
export const FEATURE_MODELS: FeatureModelDef[] = [
  {
    id: "onboarding",
    label: "Onboarding Tour",
    description: "Writes the per-repo onboarding tour.",
    defaultProvider: "anthropic",
    defaultModel: "claude-haiku-4-5-20251001",
  },
  {
    id: "review_intent",
    label: "PR Review · Intent",
    description: "Derives a PR’s intent and scope before review.",
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-5",
  },
  {
    id: "risk_brief",
    label: "Risk Brief",
    description: "Assesses merge risks for a pull request.",
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-5",
  },
  {
    id: "conformance",
    label: "Conformance",
    description: "Checks a PR against the project spec.",
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-5",
  },
  {
    id: "conventions",
    label: "Conventions",
    description: "Extracts coding conventions from the repo.",
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-8",
  },
];

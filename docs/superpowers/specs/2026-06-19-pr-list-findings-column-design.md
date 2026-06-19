# PR list — FINDINGS column with hover tooltip

**Date:** 2026-06-19
**Status:** Approved design, ready for implementation plan
**Scope:** small (one column, two new SQL queries, one new component)

## Problem

The PR list table at `/repos/:id/pulls` shows a `SCORE` ring but not the
per-severity findings breakdown. A score alone can't distinguish "73 with 3
critical issues" from "73 with 5 suggestions", forcing a click into the PR
detail page to triage. The list response was deliberately kept findings-free
(see comment at [server/src/modules/pulls/routes.ts:115-117](../../../server/src/modules/pulls/routes.ts#L115-L117))
— this design reverses that decision.

The `PrRowView` type at [client/src/lib/types.ts:38](../../../client/src/lib/types.ts#L38)
was scaffolded with a `findings: { CRITICAL, WARNING, SUGGESTION }` field but
nothing consumes it. This work wires the missing column up end-to-end.

## Goals

- Add a **FINDINGS** column to the PR list, between STATUS and UPDATED.
- Render three severity badges per row (CRITICAL, WARNING, SUGGESTION) with
  icon + count, reusing the FindingCard palette so the list and detail page
  agree visually.
- On hover, show a popover listing the top 5 finding titles for that severity.
- Click a title → deep-link to that finding on the PR detail page.
- If a severity has more than 5 findings, footer link `+N more` navigates to
  the detail page's findings tab pre-filtered by severity.

## Non-goals

- Sorting or filtering the PR list by findings.
- Visual regression tests (no existing infra).
- Live updates — findings refresh on the next normal list refetch.
- Changing what counts as a finding (dismissed → excluded; accepted →
  included — see Data section).

## UX

Layout: 7 columns instead of the current 6.

```
PULL REQUEST   AUTHOR    SIZE     SCORE   STATUS    UPDATED   FINDINGS
Add rate...    marisa   M·285     61    •Needs       3h      ⊘2  ⚠2  💡2
                                                                    ▲
                                                                    │ hover
                                                                    ▼
                                                      ┌──────────────────────┐
                                                      │ CRITICAL (2)         │
                                                      │ • Rate limit bypass… │
                                                      │ • Auth check skipped │
                                                      └──────────────────────┘
```

- **Severity icons + colors** reuse the existing `SeverityBadge` component
  already exported from `@devdigest/ui/primitives`
  ([client/src/vendor/ui/primitives/Badge.tsx](../../../client/src/vendor/ui/primitives/Badge.tsx)).
  FindingsCell renders one `SeverityBadge compact` per severity. No new
  shared helper module needed — the badge already encapsulates icon, color,
  and label, and the list will visually match the detail page by
  construction.
- **Zero counts** render as a muted-color badge with count `0` (not hidden) so
  column widths stay stable across rows.
- **PR never reviewed** (score is `null`) — render `—` in the FINDINGS cell,
  matching the current SCORE empty-state convention.
- **Tooltip:** opens on hover with a 150ms delay, closes on mouse-leave with a
  grace zone allowing the cursor to reach the popover's clickable titles.
  `@devdigest/ui` does not currently ship a tooltip primitive (verified by
  searching `client/src/vendor/ui/`), so this change adds a small in-file
  popover component (~30 lines) co-located with `FindingsCell.tsx`. Plain
  React: `onMouseEnter`/`onMouseLeave` with a `setTimeout` grace zone,
  absolute positioning relative to the badge, `aria-describedby` for a11y.
  No new dependency. If a second consumer appears later, lift to
  `@devdigest/ui/primitives` then; YAGNI for now.
- **Tooltip body:** "SEVERITY (N)" header, up to 5 titles ordered by
  `confidence DESC`. If N > 5, a footer link reads `+(N − 5) more` and
  navigates to `/repos/:id/pulls/:number?tab=findings&severity=<SEV>`.
- **Title click:** navigate to
  `/repos/:id/pulls/:number?tab=findings#finding-<id>`. The detail page's
  FindingsTab gains `severity` URL filter support and scroll-to-anchor on
  `#finding-<id>`.

## Data delivery (Option B — counts + titles inline)

Findings ride along on the existing `GET /repos/:id/pulls` response — same
endpoint, single round-trip. This matches how `score` is already injected via
the latest-review IN-query in the same handler. Decision rationale:

- A separate endpoint would add a network round-trip and a second cache key
  for marginal architecture benefit. Rejected.
- Counts-only with on-hover fetch of titles would add per-hover latency.
  Hover UX needs to feel instant. Rejected.

Payload increase ≈ 1 KB per PR (3 severities × ≤5 titles, IDs + short title
strings). For typical 5–50 row lists this is well below network noise.

## Backend changes

Single file touched: [server/src/modules/pulls/routes.ts](../../../server/src/modules/pulls/routes.ts).
No schema changes. No migrations. No new endpoints.

Two new queries added after the existing latest-review IN-query at line 121:

1. **Per-PR severity counts:**

   ```sql
   SELECT r.pr_id, f.severity, COUNT(*) AS cnt
   FROM findings f
   JOIN reviews r ON r.id = f.review_id
   WHERE r.pr_id = ANY($1)
     AND r.id IN (latest 'review' kind per pr_id)
     AND f.dismissed_at IS NULL
   GROUP BY r.pr_id, f.severity
   ```

2. **Top-5 titles per (pr_id, severity)** using a window function:

   ```sql
   SELECT pr_id, severity, id, title
   FROM (
     SELECT r.pr_id, f.severity, f.id, f.title,
       ROW_NUMBER() OVER (
         PARTITION BY r.pr_id, f.severity
         ORDER BY f.confidence DESC
       ) AS rn
     FROM findings f
     JOIN reviews r ON r.id = f.review_id
     WHERE r.pr_id = ANY($1)
       AND r.id IN (latest 'review' kind per pr_id)
       AND f.dismissed_at IS NULL
   ) ranked
   WHERE rn <= 5
   ```

JS-side grouping into the response shape mirrors the existing
`latestReviewByPr` pattern at [server/src/modules/pulls/routes.ts:119](../../../server/src/modules/pulls/routes.ts#L119):
two `Map<prId, ...>` lookups, no new abstractions.

**"Latest review" definition** — same as the existing SCORE query: latest row
in `reviews` with `kind = 'review'` per `pr_id`, ordered by `created_at DESC`.
If a PR has no review, all three severity buckets are
`{ count: 0, titles: [] }`. The frontend treats this as "—".

**Filtering rules:**

- `dismissed_at IS NULL` → dismissed findings excluded from both counts and
  titles.
- `accepted_at` is NOT filtered → accepted findings still count. Rationale: an
  accepted finding represents a real issue that was addressed, and is useful
  signal on the list ("this PR had real issues, all resolved"). If this
  policy needs to change later, it's a one-line filter addition.

**Stale code to remove:** the misleading comment at
[server/src/modules/pulls/routes.ts:115-117](../../../server/src/modules/pulls/routes.ts#L115-L117)
explicitly saying findings are intentionally not surfaced. Replace with a
one-liner describing the new behavior.

**Performance budget:** Two extra Postgres round-trips per list load. For a
50-PR list: ≤150 rows from query #1 (3 severities × 50 PRs) and ≤750 rows
from query #2 (5 titles × 3 severities × 50 PRs). Within the "the list is
small, one IN-query + JS grouping is cheap" envelope the existing handler
already operates in. No new indexes needed (`findings.review_id` is FK and
already indexed; `severity` has low cardinality).

## Data model

No schema changes.

The shared API response type ([server/src/vendor/shared/](../../../server/src/vendor/shared/),
ultimately exported as `PrMeta` from `@devdigest/shared`) gains:

```typescript
findings: {
  CRITICAL:   { count: number; titles: Array<{ id: string; title: string }> };
  WARNING:    { count: number; titles: Array<{ id: string; title: string }> };
  SUGGESTION: { count: number; titles: Array<{ id: string; title: string }> };
};
```

This is additive; existing consumers keep working. The route's Zod schema at
the boundary (per server CLAUDE.md: "Routes register Zod schemas at the
boundary") gets the same field added.

## Frontend changes

**Files touched:**

- [client/src/lib/types.ts](../../../client/src/lib/types.ts) — upgrade the
  scaffolded `PrRowView.findings` from `Record<Sev, number>` to the new
  richer shape.
- [client/src/app/repos/[repoId]/pulls/_components/PRRow/PRRow.tsx](../../../client/src/app/repos/[repoId]/pulls/_components/PRRow/PRRow.tsx) —
  insert a `<FindingsCell />` between the existing Status and Updated cells.
- [client/src/app/repos/[repoId]/pulls/[number]/_components/FindingsTab/FindingsTab.tsx](../../../client/src/app/repos/[repoId]/pulls/[number]/_components/FindingsTab/FindingsTab.tsx) —
  read an optional `?severity=<SEV>` query param to pre-filter, and add
  scroll-to-anchor on `#finding-<id>`.
- The pulls table header (in the parent of PRRow) — add `FINDINGS` column
  label and widen the grid template.

**New files:**

- `client/src/app/repos/[repoId]/pulls/_components/FindingsCell/FindingsCell.tsx`
  — pure presentation over `pr.findings`. Composes three `SeverityBadge`
  components from `@devdigest/ui/primitives` plus an in-file `<Tooltip>`
  popover (~30 lines, see "Tooltip" in UX section). No fetch, no state
  beyond hover.
- `client/src/app/repos/[repoId]/pulls/_components/FindingsCell/FindingsCell.test.tsx`
  — see Testing.

**No fetching changes.** The PR list already uses TanStack Query through
`src/lib/hooks/`. The new field piggybacks on the existing `usePulls(repoId)`
query — no new hook, no new cache key, no new loading state, no plumbing.

## Testing

**Backend** — three new tests in `server/test/pulls.it.test.ts` (or wherever
the pulls list integration tests live), running against real Postgres via
`test/helpers/pg.ts`:

1. **Counts are correct.** Seed PR A with 2 CRITICAL + 1 WARNING findings on
   its latest review; seed PR B with no findings. Assert the response has
   `findings.CRITICAL.count === 2`, `findings.WARNING.count === 1`,
   `findings.SUGGESTION.count === 0` on A; all zeros on B.
2. **Top-5 titles respect confidence DESC.** Seed 7 CRITICAL findings with
   distinct `confidence` values. Assert exactly 5 titles returned, in
   confidence DESC order.
3. **Dismissed findings are excluded.** Seed a CRITICAL with `dismissed_at`
   set. Assert it's NOT in counts and NOT in titles.

**Frontend** — two component tests in
`client/src/app/repos/[repoId]/pulls/_components/FindingsCell/FindingsCell.test.tsx`:

1. **All three badges render with correct counts.** Given counts
   `{ CRITICAL: 2, WARNING: 0, SUGGESTION: 5 }`, assert three badges with
   the right values. Zero-count badge is visually muted (asserted via class
   or computed style), not hidden — column widths must stay consistent.
2. **Tooltip shows titles and deep-links.** Hover the CRITICAL badge with
   `userEvent.hover()`; assert the popover renders with the seeded titles;
   assert clicking a title fires navigation to
   `/repos/:id/pulls/:number?tab=findings#finding-<id>` (use the existing
   mock router pattern in the repo).

**Not tested in this change:**

- Scroll-to-anchor on the detail page — small enough to verify manually.
- Visual snapshot/regression — no existing infra in this repo.

## Test plan (manual)

1. Run `pnpm dev` server + client. Pick a repo with at least one PR that has
   findings of mixed severities.
2. Open `/repos/:id/pulls`. Confirm: 7 columns, FINDINGS appears between
   STATUS and UPDATED, badges render per severity, zero counts are visible
   but muted, unreviewed PRs show `—`.
3. Hover a non-zero badge. Confirm: popover opens after ~150ms, lists up to
   5 titles by confidence DESC, closes when cursor leaves.
4. Click a title. Confirm: navigation to the detail page, FindingsTab is
   active, the page scrolls to the clicked finding.
5. For a severity with more than 5 findings, click `+N more`. Confirm: the
   detail page opens with FindingsTab pre-filtered to that severity.
6. Dismiss a finding from the detail page; refetch the list. Confirm: the
   dismissed finding is no longer in the count or tooltip.

## Risks

- **Misleading code comment removal.** Removing the "intentionally not
  surfaced" comment at routes.ts:115-117 is a documented design reversal.
  The replacement comment should make the new behavior obvious to future
  readers.
- **Latest-review semantics drift.** If the existing SCORE query's definition
  of "latest review" ever changes, the FINDINGS query must change in lockstep
  or the column will visibly disagree with the score. Co-locating both
  queries in the same handler (which is already the case) keeps this risk
  manageable. Worth a code comment.
- **Tooltip on touch devices.** Hover is not a primitive on touch screens.
  A future follow-up: click-to-open-tooltip on touch, with the same content.
  Out of scope here.

## Follow-ups (explicitly deferred)

- Sort or filter the PR list by findings (e.g., "PRs with any CRITICAL").
- Touch-friendly tooltip interaction.
- Accepted-findings policy review (currently included; might be wrong).
- Visual regression tests for the new column.
- Optional dot-density variant where the FINDINGS column shows three colored
  dots without numbers, for ultra-compact lists.

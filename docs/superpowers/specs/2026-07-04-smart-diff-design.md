# Smart Diff — design

**Status:** design approved (autopilot mode) — ready to hand off to planner
**Date:** 2026-07-04
**Branch target:** `l03` (current working branch)

## 1. Goal

Reorder and group PR files so the reviewer sees business logic first and lock/generated files last. On files where the latest structured review found issues, surface a "N findings" badge that jumps to the flagged line.

Zero new LLM calls at this layer. The expensive call already happened in the structured review step; Smart Diff is deterministic composition over data the system already has.

**Non-goals**
- No LLM-based `pseudocode_summary` (the contract reserves the field; MVP leaves it `null`).
- No automatic PR-split proposal (`proposed_splits` stays `[]`; MVP only reports `too_big` + `total_lines`).
- No new persistence — classification is computed on read, never stored.
- No re-ordering inside a group; natural forge order is preserved.
- No dependency on the intent layer (Smart Diff must work before any LLM has run).

## 2. Decisions log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Reuse the existing `SmartDiff` Zod contract in `contracts/brief.ts:80-113` | Contract is already committed and shipped with matching role vocabulary (`core`/`wiring`/`boilerplate`); reinventing would fork the schema. |
| D2 | Dedicated route `GET /pulls/:id/smart-diff` (not embedded in `PrDetail`) | Contract shape implies a standalone payload; future LLM enrichment (`pseudocode_summary`, `proposed_splits`) will have an independent cache lifetime from PR detail. |
| D3 | Classifier is a pure server-side module under `modules/pulls/smart-diff/`, not in `reviewer-core` | Only the server consumes it in MVP; YAGNI on shared placement. Can hoist later if the client ever needs it standalone. |
| D4 | Classification is path-pattern-first, then size-fallback | Path is the strongest deterministic signal; size only kicks in as a boilerplate override for unfamiliar extensions with huge diffs. |
| D5 | `too_big` threshold: `total_lines > 1000` (additions + deletions across all files) | Visible-but-not-annoying default; single knob in `patterns.ts` for tuning. |
| D6 | Ordering inside a group is natural forge order | Reordering inside a group is a UX call for a follow-up; MVP keeps it predictable. |
| D7 | Boilerplate group collapsed by default in UI | The whole point of the feature — hide low-signal changes. |
| D8 | Finding badge severity color = highest-severity finding in the file | Simple and predictable; matches how `FindingsCell` already colors PR list rows. |

## 3. What already exists (and what we reuse)

- **Contract:** `SmartDiff`, `SmartDiffGroup`, `SmartDiffFile`, `SmartDiffRole` at [`server/src/vendor/shared/contracts/brief.ts:80-113`](../../../server/src/vendor/shared/contracts/brief.ts). Vendored to `client/src/vendor/shared/contracts/brief.ts`. Symbol already re-exported from `@devdigest/shared` ([`client/src/lib/types.ts:35`](../../../client/src/lib/types.ts)).
- **PR files:** `pr_files` table at [`server/src/db/schema/pulls.ts:36-45`](../../../server/src/db/schema/pulls.ts) — `{ path, additions, deletions, patch }`. Populated on every `GET /pulls/:id` refresh.
- **Findings:** `findings` table at [`server/src/db/schema/reviews.ts:55-73`](../../../server/src/db/schema/reviews.ts) — `{ file, start_line, end_line, severity, ... }`. Latest review per PR is ordered `desc(reviews.createdAt)` filtered by `kind='review'` (pattern from [`modules/pulls/routes.ts:26-36`](../../../server/src/modules/pulls/routes.ts)).
- **Route module:** `server/src/modules/pulls/routes.ts` — this is where `GET /pulls/:id/smart-diff` gets registered (co-located with `GET /pulls/:id`).
- **Diff renderer:** `client/src/components/diff-viewer/` — public surface `DiffViewer` component + `DiffCommentApi`. Reused as the leaf renderer inside each group.
- **PR detail page:** `client/src/app/repos/[repoId]/pulls/[number]/_components/DiffTab/DiffTab.tsx` — currently renders `<DiffViewer files={files} …/>` flat. This is the file we edit for grouping.
- **API client:** all server access routes through `client/src/lib/api.ts`; hooks under `client/src/lib/hooks/`. New hook `useSmartDiff(prId)` follows the same TanStack Query pattern as existing hooks.

What we build fresh: the classifier, the composer, the route, the hook, the grouped-render surgery on `DiffTab`.

## 4. Architecture

```
                          ┌────── DiffTab (client) ──────┐
                          │  useSmartDiff(prId)          │
                          └──────────────┬───────────────┘
                                         │
                       GET /pulls/:id/smart-diff
                                         │
             ┌───────────────────────────▼──────────────────────────┐
             │  routes.ts  →  smart-diff/service.ts (composer)      │
             └──────┬───────────────────────────┬───────────────────┘
                    │                           │
        read pr_files (repo)          read latest review findings
                    │                           │
                    ▼                           ▼
             classifier.ts  ←──────────  patterns.ts (constants)
                    │
                    ▼
             SmartDiff (contract)
```

**Server-side layout (new files):**

```
server/src/modules/pulls/smart-diff/
├── patterns.ts        — path-pattern constants + thresholds
├── classifier.ts      — pure classifyFiles(files): SmartDiffGroup[]
├── service.ts         — composeSmartDiff(files, findings): SmartDiff
└── classifier.test.ts — unit tests (patterns coverage, priority order)
```

Route added to existing `server/src/modules/pulls/routes.ts`.

**Client-side layout (new + modified files):**

```
client/src/lib/hooks/smart-diff.ts   — useSmartDiff(prId) TanStack Query hook
client/src/app/repos/[repoId]/pulls/[number]/_components/
├── DiffTab/DiffTab.tsx              — MODIFY: consume useSmartDiff, render groups
└── DiffTab/GroupHeader.tsx          — NEW: role label + finding count + collapse toggle
```

`DiffTab` becomes a shell that iterates over `SmartDiff.groups`, renders one `<GroupHeader/>` + one `<DiffViewer files={group.files}/>` per group. `finding_lines` are threaded into `DiffViewer` via a new optional prop for line highlighting (see §7 for the prop-shape decision).

## 5. Classification rules

Priority order — first match wins:

**boilerplate** (path patterns):
- Lock files: filename in `{ pnpm-lock.yaml, package-lock.json, yarn.lock, bun.lockb, Cargo.lock, Gemfile.lock, poetry.lock, uv.lock, composer.lock, go.sum, mix.lock, Podfile.lock }`
- Build artifacts: path matches `**/dist/**`, `**/build/**`, `**/.next/**`, `**/out/**`, `**/coverage/**`
- Minified/mapped: path matches `**/*.min.js`, `**/*.min.css`, `**/*.map`
- Vendored: path matches `**/node_modules/**`, `**/vendor/**`
- Snapshots: path matches `**/__snapshots__/**`, `**/*.snap`
- DB migrations: path matches `**/migrations/**/*.sql`

**wiring** (path patterns):
- Barrel/index files: basename in `{ index.ts, index.tsx, index.js, index.jsx, mod.rs, __init__.py }`
- Config: path matches `**/*.config.{ts,js,mjs,cjs,json}` or basename matches `tsconfig*.json`, `next.config.*`, `vitest.config.*`, `vite.config.*`, `drizzle.config.*`, `tailwind.config.*`, `postcss.config.*`, `eslint.config.*`, `.eslintrc*`, `.prettierrc*`
- Manifests: basename in `{ package.json, pyproject.toml, Cargo.toml, Gemfile, go.mod }`
- CI/tooling: path starts with `.github/` or basename is `Dockerfile`, `docker-compose*.yml`, `.gitlab-ci.yml`
- Env files: basename matches `.env*`

**core** (default):
- Anything that didn't match above.

**Size-based override (boilerplate only):**
- If a path DID NOT match a boilerplate pattern but has an unfamiliar extension (not one of `.ts .tsx .js .jsx .py .go .rs .java .kt .rb .php .c .cc .cpp .h .hpp .cs .swift .scala .ex .exs .clj .css .scss .md .sql .yaml .yml .json .toml`) AND `additions + deletions > 500` → reclassify as `boilerplate`. This catches large binary-ish text dumps (e.g., checked-in datasets) without needing a bespoke pattern for each.

All patterns and the size threshold live in `patterns.ts` as named exports so tests can assert against them directly.

## 6. Response composition

```ts
composeSmartDiff(files: PrFile[], findings: Finding[]): SmartDiff {
  const roleByPath = classifyFiles(files);              // Map<path, SmartDiffRole>
  const findingsByFile = groupBy(findings, f => f.file); // Map<path, Finding[]>

  const groups: SmartDiffGroup[] = (['core','wiring','boilerplate'] as const).map(role => ({
    role,
    files: files
      .filter(f => roleByPath.get(f.path) === role)
      .map(f => ({
        path: f.path,
        pseudocode_summary: null,                        // LLM-only, reserved
        additions: f.additions,
        deletions: f.deletions,
        finding_lines: (findingsByFile.get(f.path) ?? [])
          .map(x => x.start_line)
          .sort((a,b) => a - b),
      })),
  }));

  const total_lines = files.reduce((s, f) => s + f.additions + f.deletions, 0);
  return {
    groups,
    split_suggestion: {
      too_big: total_lines > 1000,
      total_lines,
      proposed_splits: [],                               // LLM-only, reserved
    },
  };
}
```

Empty groups are still returned (empty `files: []`) so the client can render placeholders uniformly. Order of `groups` is always `[core, wiring, boilerplate]`.

## 7. UI

`DiffTab` becomes SmartDiff-aware:

```
┌ core (7 files, 12 findings) ────────────────── [expanded]
│  ┌ src/modules/pulls/service.ts       [3 CRITICAL] ┐
│  │ … diff …                                        │
│  └──────────────────────────────────────────────────┘
│  ┌ src/modules/pulls/routes.ts        [1 SUGGESTION]
│  │ … diff …
│  └──
├ wiring (3 files) ─────────────────────────────── [expanded]
│  ┌ package.json
│  │ … diff …
│  └──
└ boilerplate (2 files) ─────────────────── ▶ [collapsed]
```

**Behaviors:**
- Group header shows `{role}` + file count + total finding count (sum across files in the group).
- Each file card shows a badge `"{N} findings"` only when `finding_lines.length > 0`. Color derives from the highest severity present in that file's findings (CRITICAL red → WARNING amber → SUGGESTION blue). Severity per file is looked up from the same latest-review findings the server used (client fetches via existing `usePrReviewLatest` hook OR the server embeds highest severity per file in the response — see D9).
- Clicking the badge scrolls to `finding_lines[0]`, and expands the group if collapsed.
- Boilerplate group is collapsed by default; user toggle is local state (not persisted for MVP).
- If `split_suggestion.too_big`, a subtle banner appears above the groups: `"This PR is {total_lines} lines. Consider splitting."` No action buttons (no `proposed_splits` yet).

**D9 (deferred, but decided here):** The current `SmartDiffFile` shape has only `finding_lines: number[]` — no severity per file. For MVP the client fetches the severity buckets it already receives from `GET /pulls/:id` (`PrMeta.findings.CRITICAL.count`, etc.) and cross-references by file. If cross-referencing turns out to be awkward, a follow-up spec adds `top_severity` to `SmartDiffFile`. Not a contract change today.

## 8. Testing

**Server (`server/`):**
- `smart-diff/classifier.test.ts` — one case per pattern group, plus:
  - Priority: a file matching both wiring and boilerplate patterns lands in boilerplate.
  - Size override: a `.dat` file with 501 additions → boilerplate; with 499 additions → core.
  - Empty inputs → three empty groups.
- `smart-diff/service.test.ts` — composer:
  - Findings anchored to files that don't appear in `files` are ignored (no ghost entries).
  - `finding_lines` sorted ascending, deduplicated is NOT required (contract allows duplicates).
  - `total_lines` = sum of `additions + deletions` across all files.
- `modules/pulls/routes.smart-diff.it.test.ts` — integration:
  - PR with files but no reviews → all `finding_lines: []`.
  - PR with two reviews → uses latest.
  - PR not owned by workspace → 404.

**Client (`client/`):**
- `useSmartDiff.test.tsx` — happy path fetch + error state.
- `DiffTab.test.tsx` — updated:
  - Renders three group headers with correct counts.
  - Boilerplate group collapsed by default; clicking header expands.
  - File with `finding_lines` shows badge; without doesn't.
  - Badge click calls scroll-into-view on the target file row.
  - `too_big` banner appears when `split_suggestion.too_big === true`.

## 9. Migration / rollout

- No DB migration.
- No contract migration — reusing shipped `SmartDiff` schema.
- No feature flag — endpoint is additive, DiffTab is either grouped-with-data or falls back to flat rendering while the request is in flight.
- Backward compatibility: if the request fails or returns empty, DiffTab renders the current flat `DiffViewer` view over `PrDetail.files` (graceful degradation).

## 10. Open questions (non-blocking)

- Should `wiring` show any severity aggregation, or only `core`? MVP: aggregate everywhere; tune based on user feedback.
- Should the user's "boilerplate expanded" preference persist across sessions? MVP: no. Trivial follow-up if requested.
- Does `too_big` need per-role breakdown ("N lines of core changes")? MVP: no; single total.

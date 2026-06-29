# Conventions Extractor + API Contract Reviewer — Design Spec

**Date:** 2026-06-23
**Branch:** l02
**Status:** Approved for implementation

---

## Overview

Two independent deliverables built on top of the existing DevDigest skill machinery:

- **Part A — Conventions Extractor:** Analyzes a repo's codebase with a cheap LLM, extracts coding conventions as candidates, verifies them against file content, lets the user accept/reject/edit, then creates one skill per category from accepted candidates.
- **Part B — API Contract Reviewer:** A custom reviewer agent with 4 directive skills that detects breaking API changes in PRs. Requires authoring `.md` skill files, UI agent setup, skill linking (including one via `.md` import), and a controlled with/without-skills experiment.

Part B requires zero new server code. Part A adds a new `conventions` module (server + client).

---

## Part A — Conventions Extractor

### What already exists (reuse, do not rebuild)

| Component | Location | Status |
|---|---|---|
| `conventions` DB table | `server/src/db/schema/knowledge.ts:31` | ✅ Migrated (fields: `id`, `workspace_id`, `repo_id`, `rule`, `evidence_path`, `evidence_snippet`, `confidence`, `accepted`) |
| `ConventionCandidate` Zod contract | `server/src/vendor/shared/contracts/knowledge.ts` | ✅ Defined, unused |
| `repoIntel.getConventionSamples(repoId, n)` | `server/src/modules/repo-intel/service.ts:630` | ✅ Returns top-N ranked file paths, tests/configs excluded |
| `conventions` feature-model entry | `server/src/vendor/shared/contracts/platform.ts` | ✅ Registered; default provider: `openai`, model: `gpt-5.4` |
| Skill type `'convention'` | `server/src/db/schema/skills.ts:12` | ✅ Allowed enum value |
| Skill source `'extracted'` | `server/src/db/schema/skills.ts:14` | ✅ Allowed enum value |
| `POST /skills` creation route | `server/src/modules/skills/routes.ts:60` | ✅ Reused for skill creation step |
| `POST /agents/:id/skills` linking route | `server/src/modules/agents/routes.ts:167` | ✅ Reused for agent-link step |
| `Conventions` nav item | `client/src/vendor/ui/nav.ts:40` | ✅ Declared but `disabled: true` |
| Active-key detection for `/conventions` | `client/src/components/app-shell/helpers.ts:31` | ✅ Ready |

### New server module: `server/src/modules/conventions/`

Following the existing module pattern: `routes.ts → service.ts → repository.ts`, registered in `server/src/modules/index.ts`.

#### Routes

```
POST   /repos/:id/conventions/extract         SSE stream — runs extraction, emits progress events
GET    /repos/:id/conventions                  list all candidates (optional ?accepted=bool filter)
PATCH  /conventions/:id                        update rule text or accepted flag
POST   /repos/:id/conventions/to-skills        create skills from accepted candidates; optional agent link
```

All routes are scoped to `workspaceId` (from session), enforced in the service layer.

#### Extraction pipeline (`extractor.ts`)

The `POST /repos/:id/conventions/extract` handler streams SSE events via the existing response pattern used in the reviews module. The pipeline:

1. **Delete** all existing convention candidates for this `repo_id` (replace-all semantics on re-scan).
2. **Sample config files** (eslint, tsconfig, prettier, `.editorconfig`) from the repo's working directory. Emit `{type:'sampling', message:'Reading config files...'}`.
3. **Sample source files:** call `repoIntel.getConventionSamples(repoId, 12)` → 12 ranked file paths. Read their contents (first 150 lines each to stay within token budget). Emit `{type:'sampling', message:'Reading 12 source files...'}`.
4. **Call LLM.** Resolve model via `resolveFeatureModel(container, workspaceId, 'conventions')`. Use `llm.completeStructured()` with the Zod schema below. Emit `{type:'analyzing', message:'Analyzing conventions...'}`.
5. **Verify evidence.** For each LLM candidate, check that `evidence_snippet` appears in the sampled file content held in memory. Candidates whose `evidence_path` was not in the sampled set, or whose `evidence_snippet` does not appear verbatim in that file's content, are discarded. Emit `{type:'verifying', total, done}` per candidate.
6. **Persist** verified candidates to the `conventions` table. Emit `{type:'done', count}`.

**Why in-memory verification works:** The LLM receives the file contents we sampled. Any snippet it cites must appear in those contents verbatim — no disk re-read or repo clone access is needed.

#### LLM output Zod schema

```typescript
const ConventionCandidateOutput = z.object({
  candidates: z.array(z.object({
    category: z.string(),         // "async-style" | "naming" | "error-handling" | ...
    rule: z.string(),             // human-readable rule description
    evidence_path: z.string(),    // relative file path (must be in sampled set)
    evidence_snippet: z.string(), // exact code excerpt from that file
    confidence: z.number().min(0).max(1),
  })),
});
```

#### `to-skills` route logic

1. Fetch all accepted candidates for this repo.
2. Group by `category`.
3. For each group, generate a skill body in markdown: heading = category name, each rule as a `##` section with evidence code block.
4. Call `POST /skills` (reuse service, not HTTP) with `type:'convention'`, `source:'extracted'`.
5. If `agentId` is provided in the request body, call the agent skills service to link each created skill.
6. Return `{ skills: Skill[] }`.

#### Extraction prompt

New file: `server/src/prompts/conventions-extract.system.md`

The prompt instructs the model to:
- Act as a coding convention detector, not a style critic.
- Return only conventions that are **consistently observed** across multiple files (not one-off patterns).
- Provide exactly one code snippet as evidence, taken verbatim from the provided files.
- Assign `confidence` based on how consistently the pattern appears (0.9 = seen in 5+ files, 0.5 = seen in 2 files).
- Use short descriptive `category` slugs: `async-style`, `naming`, `error-handling`, `imports`, `typing`, `testing`, `http-layer`, etc.

#### Repository layer

```typescript
// conventions/repository.ts
deleteByRepo(workspaceId: string, repoId: string): Promise<void>
insertMany(rows: InsertConvention[]): Promise<Convention[]>
listByRepo(workspaceId: string, repoId: string, opts?: { accepted?: boolean }): Promise<Convention[]>
update(workspaceId: string, id: string, patch: { rule?: string; accepted?: boolean }): Promise<Convention>
```

---

### New client page: `client/src/app/conventions/`

#### Enable the nav item

In `client/src/vendor/ui/nav.ts`: change `disabled: true` → `disabled: false`, set `href: '/conventions'`.

#### Page anatomy (`page.tsx`)

```
┌─────────────────────────────────────────────────────┐
│  Conventions in [repo-selector ▼]        [Re-scan]  │
│  Detected from 84 sample files · last scan 1h ago   │
├─────────────────────────────────────────────────────┤
│  [ExtractionProgress] (visible only during scan)    │
│  "Analyzing conventions…  Verifying 8 candidates…" │
├─────────────────────────────────────────────────────┤
│  [✕ Deselect all]   3 of 5 accepted        [Create skills ✦] │
├─────────────────────────────────────────────────────┤
│  ┌─ ConventionCard ──────────────────────────────┐  │
│  │  async-style                                  │  │
│  │  Always use async/await instead of .then()    │  │
│  │  src/api/users.ts:23  ░░░░░░░░░░  91%         │  │
│  │  ```                                          │  │
│  │  const user = await db.users.find(id);        │  │
│  │  ```                                          │  │
│  │  [Edit]   [✓ Accepted] [✕ Reject]             │  │
│  └────────────────────────────────────────────── ┘  │
│  ... more cards ...                                 │
└─────────────────────────────────────────────────────┘
```

- **Confidence bar**: green ≥ 0.8, orange 0.5–0.79, red < 0.5.
- **Edit**: opens an inline expand on the card (not a modal) — a `<textarea>` for the rule text with Save/Cancel. Updates via `PATCH /conventions/:id`.
- **Accept / Reject**: toggle buttons. Accepted cards are visually highlighted.
- **Create skills button**: enabled when ≥1 candidate is accepted. Label: "Create X skills".

#### "Create skills from conventions" modal

Shows one collapsible section per category (the groups that will become skills). Each section has:
- Editable `name` input (auto-filled: `{repo-slug}-{category}`)
- Editable `description` input
- Expandable skill body preview (markdown, editable `<textarea>`)
- Accepted convention count for that category (e.g. "2 conventions")

Footer:
- Optional "Also link to agent" `<select>` (lists workspace agents)
- "Create X skills" (primary) + "Cancel"

After creation: toast "3 skills created and added to Skills Lab". The modal closes.

#### API client additions (`client/src/lib/api.ts`)

```typescript
extractConventions(repoId: string): EventSource                            // SSE stream
getConventions(repoId: string, opts?: { accepted?: boolean }): Promise<{ candidates: ConventionCandidate[]; scannedAt: string | null }>
updateConvention(id: string, patch: { accepted?: boolean; rule?: string }): Promise<void>
createSkillsFromConventions(repoId: string, opts?: { agentId?: string }): Promise<{ skills: Skill[] }>
```

`scannedAt` is derived from `MAX(created_at)` of the repo's convention rows; `null` when no scan has run yet. Used to render "last scan 1h ago" in the page header.

---

## Part B — API Contract Reviewer

### Zero new server code

Everything is done through existing UI flows and skill file authoring.

### 4 skill `.md` files

Store under `server/src/prompts/skills/api-contract/` for reference. These are the sources for import and manual creation.

> Note: the 4 skills below use `type: rubric` (enforced rules), not `type: convention` (observed patterns). Convention type is reserved for candidates produced by the Conventions Extractor.

#### `breaking-change.md`
```markdown
---
name: breaking-change
description: Flags removal or renaming of any public API contract element
type: rubric
---

# Breaking Change Detection

Flag any diff that removes, renames, or changes the HTTP method of a public route,
or removes/renames a field in a public request or response body.

## Bad

\`\`\`diff
- router.delete('/users/:id', handler)
+ router.delete('/accounts/:id', handler)
\`\`\`

Route path renamed without backward-compatible alias. Existing clients break silently.

## Good

\`\`\`diff
+ router.delete('/accounts/:id', handler)  // new path
+ router.delete('/users/:id', legacyRedirect)  // backward-compatible alias, deprecated
\`\`\`

Cite the file:line of the removed or renamed element and explain which clients it breaks.
```

#### `response-schema.md`
```markdown
---
name: response-schema
description: Flags type changes, field renames, or optionality changes in API responses
type: rubric
---

# Response Schema Integrity

Flag any diff that changes the shape of a response body: field renaming,
type changes (string→number), required→optional or optional→required changes,
or removal of existing fields.

## Bad

\`\`\`diff
- return { user_id: user.id, name: user.name }
+ return { userId: user.id, name: user.name }
\`\`\`

Field renamed from `user_id` to `userId`. Any client reading `user_id` now gets `undefined`.

## Good

\`\`\`diff
  return {
    user_id: user.id,   // kept for backward compatibility
+   userId: user.id,    // new canonical name
    name: user.name,
  }
\`\`\`

Cite the file:line of the changed field and explain the client impact.
```

#### `semver-discipline.md`
```markdown
---
name: semver-discipline
description: Asserts that breaking API changes require a major version bump
type: rubric
---

# SemVer Discipline

Any breaking change to a public API contract requires a major version increment
(MAJOR.minor.patch). Flag PRs that introduce breaking changes without a
corresponding version bump in the version file or CHANGELOG.

## Bad

A PR that renames a response field or removes a route, with no changes to
`package.json` version or `CHANGELOG.md`.

## Good

\`\`\`diff
- "version": "2.4.1"
+ "version": "3.0.0"
\`\`\`

With a CHANGELOG entry listing all breaking changes and migration instructions.

If a breaking change is found and no version bump is present, flag it as a blocker.
```

#### `deprecation-policy.md`
```markdown
---
name: deprecation-policy
description: Requires @deprecated annotation before silent removal of API elements
type: rubric
---

# Deprecation Policy

Never silently remove a public route, parameter, or response field.
Always annotate the element as deprecated first, then remove it in a subsequent
major release.

## Bad

\`\`\`diff
- router.get('/v1/users', legacyHandler)
\`\`\`

Route deleted without prior deprecation notice. Clients get 404 with no warning.

## Good

\`\`\`diff
  /**
+  * @deprecated — use GET /v2/users instead. Will be removed in v4.0.
   */
  router.get('/v1/users', legacyHandler)
\`\`\`

Flag any diff that removes a public element without a prior `@deprecated`
annotation or deprecation header in the response.
```

### Agent setup (via DevDigest UI)

| Field | Value |
|---|---|
| Name | API Contract Reviewer |
| Description | Detects breaking changes, schema drift, and versioning violations in API PRs |
| Provider | anthropic |
| Model | `claude-sonnet-4-6` |
| Strategy | `single-pass` |
| `ci_fail_on` | `critical` |
| `repo_intel` | `true` |

**System prompt:**
```
You are an API Contract Reviewer. Your job is to detect breaking changes, schema drift, and versioning violations in pull request diffs.

Review the diff strictly for API contract integrity. Focus only on:
- Route path changes (additions, removals, renames, method changes)
- Request body field changes (renames, type changes, required/optional changes)
- Response body field changes (renames, type changes, additions that could break strict parsers, removals)
- Version file / CHANGELOG alignment with breaking changes
- Deprecation annotation presence before element removal

Do NOT comment on code style, performance, test coverage, or logic correctness unless it directly affects the public API contract.

For each violation found: cite the specific file and line number, state which clients are affected, classify the severity (critical = silent breakage for existing clients, warning = non-backward-compatible change that is at least annotated), and suggest the correct approach.
```

### Skill linking

1. Create 3 skills manually via the Skills Lab UI editor.
2. Import 1 skill (`breaking-change.md`) via the `.md` upload flow (`POST /skills/import/preview` → confirm → `POST /skills`). This rehearses the import path.
3. Link all 4 to the agent via the Skills tab (drag-to-reorder, all enabled).

### Experiment

**Setup:** on the existing connected repo, create a branch `experiment/breaking-api-change` that makes two deliberate violations:
1. Rename a response field (e.g. `user_id` → `userId`) in a handler file.
2. Make an optional field required in the request schema.

Open a PR from that branch.

**Run 1 — without skills:** Run the API Contract Reviewer agent on the PR with all 4 skills disabled (or temporarily unlinked). Expected: agent either misses the breaking changes or describes them in generic terms without citing specific contract violations.

**Run 2 — with skills:** Enable all 4 skills. Re-run. Expected: agent cites specific file:line for the renamed field, flags the missing `@deprecated` annotation, and may flag the missing major version bump.

**Document the delta:** capture both run summaries and findings lists. The comparison demonstrates the skills' additive value over the base system prompt.

---

## Product improvement ideas for Conventions Extractor quality

The following are not in scope for this implementation but worth tracking:

1. **Multi-pass extraction:** Run the LLM twice with different temperature/sampling seeds; deduplicate results. Finds more conventions.
2. **Config-first analysis:** Parse ESLint rules, TSConfig `strict` flags, and Prettier config into structured facts before the LLM call. Feed these as structured context, not raw text — avoids hallucination on config semantics.
3. **Symbol-aware sampling:** Instead of top-N files by rank, sample one file per distinct symbol kind (function, class, route handler, test, type). Better coverage of different convention surfaces.
4. **Confidence calibration from frequency:** Count actual occurrences of the detected pattern across all sampled files. Override LLM-reported confidence with a computed frequency score.
5. **Chat history conventions (à la Claude Code `/insights`):** Analyze PR review comment history for recurring reviewer complaints — these are often implicit conventions the codebase enforces socially but not in code.

---

## Implementation sequence

### Part A (Conventions Extractor)

1. New `conventions` module: repository → service → routes → register in `modules/index.ts`
2. Extraction prompt: `server/src/prompts/conventions-extract.system.md`
3. Extractor: file sampling (configs + `getConventionSamples`), LLM call, evidence verification, persist
4. SSE streaming: follow existing pattern from `reviews` module
5. `to-skills` route: group by category, create via `SkillsService`, optional agent link
6. Client: enable nav item, new `/conventions` page, `ExtractionProgress`, `ConventionCard`, `CreateSkillsModal`
7. API client methods: `extractConventions`, `getConventions`, `updateConvention`, `createSkillsFromConventions`

### Part B (API Contract Reviewer)

1. Author 4 skill `.md` files under `server/src/prompts/skills/api-contract/`
2. Create agent via UI with system prompt above
3. Create 3 skills via UI editor; import 1 via `.md` upload
4. Link all 4 to the agent
5. Create `experiment/breaking-api-change` branch on the connected repo
6. Run experiment: without skills → with skills; document findings delta

---

## Risks and open questions

| Risk | Mitigation |
|---|---|
| `repoIntel.getConventionSamples` returns paths only — file content reading requires repo clone access | Confirmed: the extractor reads file contents before passing to LLM; same access pattern as the indexer. Verify `container.git.readFile()` or equivalent exists during implementation. |
| SSE pattern for POST endpoints — verify existing usage in reviews module before copying | Check `reviews/routes.ts` SSE response setup; follow exactly. |
| LLM evidence quality — model hallucinates non-existent snippets | In-memory verification discards hallucinated evidence. The system degrades gracefully (fewer candidates, no false positives). |
| `gpt-5.4` may not exist as a real model ID | `resolveFeatureModel` will use whatever the workspace has configured. Default is advisory; use a real cheap model ID during implementation (`gpt-4o-mini` or `claude-haiku-4-5`). |
| Experiment PR: existing connected repo may not have a suitable route to break | If no suitable file exists, create a minimal `routes/users.ts` file on the experiment branch. |

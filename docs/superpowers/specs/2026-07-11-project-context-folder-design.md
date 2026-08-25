# Project Context Folder (L05) — design

Date: 2026-07-11
Status: **Approved (2026-07-11).** Brainstormed and approved for full-feature scope in one spec, phased plan.

## Context

DevDigest reviews PRs with configurable agents. L02–L04 already built — but left **unused** — the plumbing to inject project markdown into a review prompt:

- The `## Project context` slot in [`reviewer-core/src/prompt.ts`](../../../reviewer-core/src/prompt.ts) (line ~114). Each spec chunk is wrapped `<untrusted source="spec-N">…</untrusted>` via `wrapUntrusted` (prompt.ts:30-34) and the `INJECTION_GUARD` (prompt.ts:16-28) already names specs as untrusted data.
- The `specs` input threads cleanly: `run-executor → reviewPullRequest (reviewer-core/src/review/run.ts:134) → assemblePrompt`. Today the executor never passes `specs`.
- The trace already carries `specs_read: z.array(z.string())` and `PromptAssembly.specs` ([`server/src/vendor/shared/contracts/trace.ts`](../../../server/src/vendor/shared/contracts/trace.ts):71-88, 39-53), both hardcoded to `[]` / `null` today.
- On-disk clones are readable via `container.git.readFile(repo, path)` / `container.git.clonePathFor(repo)` ([`server/src/adapters/git/simple-git.ts`](../../../server/src/adapters/git/simple-git.ts):37-39, 129-131). Clone root: `<cloneDir>/<owner>/<repo>`.
- A `SpecFile` contract exists (`contracts/platform.ts:271-277`), plus client hooks `useContextFiles(repoId)` / `useReindexContext` (`client/src/lib/hooks/core.ts:126-141`) targeting `GET /repos/:repoId/context` — **but no server route implements it**.
- The nav item `{ key: "context", label: "Project Context", disabled: true, href: "#" }` exists in `client/src/vendor/ui/nav.ts:32` (a `vendor/` do-not-touch zone).

**The screenshots in the brief are aspirational mockups.** In the actual code, the agent editor has only 3 tabs (`config`, `skills`, `versions`), the skill editor is a flat form (no tabs), and the Project Context screen does not exist. So all three client surfaces are net-new UI.

This feature turns any repo spec/doc/insight markdown into review context: attach it to an agent (and/or a skill it uses), and at run time the reviewer reads it fresh, cites it, and the trace shows exactly what was read. It is the bridge to L06, where a dedicated agent will verify implementation against the spec and block merge.

## Goals

- Discover all `.md` under `specs/`, `docs/`, `insights/` folders (any depth) in the repo clone and expose them with paths.
- Let authors **manually attach** discovered docs to a **review agent** and to a **skill**, storing paths (not text).
- At run time, read the effective set fresh, inject into the existing `## Project context` slot (untrusted-wrapped), and record `specs_read` + per-doc token size in the trace.
- Zero new LLM calls.
- Live acceptance: attach a spec with an invariant → open a PR that violates it → the reviewer flags it, citing the spec.

## Non-goals (v1)

- **Auto-select / flash-selector** — picking specs per PR automatically. Manual attach only.
- **Vector chunk index** — the mockup's "indexed N files / 1,240 chunks" is the separate embedding/search concern, not needed for attach+inject.
- **Token budget cap** — tokens are *shown* in the trace; no cap enforced in v1.
- Editing docs from DevDigest — docs are read-only, sourced from the clone.

## Decisions

| # | Question | Decision |
|---|---|---|
| Q1 | Reader model | **On-demand glob (stateless).** Server globs the clone per request and reads file contents fresh at run time. No new DB table; `reindex` just re-globs. |
| Q2 | Storage mechanism | **jsonb `string[]` column** `attached_context_paths` on both `agents` and `skills`, mirroring `skills.evidenceFiles`. Order = array index; membership = presence. No join table (docs are files, not DB rows). |
| Q3 | Agent versioning | **Version the path list.** Attached paths join the `configJson` snapshot + `isConfigChange` bump predicate. **Frozen list, live contents** (see Data flow). |
| Q4 | Skill→agent inheritance | **Merge + show inherited (read-only).** Effective set = agent's own paths (in order) → inherited from enabled skills (in skill order) → dedup by path, first wins. Inherited docs shown greyed/read-only in the agent Context tab. |
| Q5 | Stale path at run time | **Fail the run** via a cheap **pre-flight** (before any LLM tokens), naming the exact missing/escaping path, recorded in the trace. Plus **save-time validation** to catch most staleness early. |
| Q6 | `kind` badge (specs/docs/insights) | **Derived from path on the client.** Avoids changing the `SpecFile` contract in the `vendor/` do-not-touch zone. |
| Q7 | Path traversal | **Hard MUST.** Both save-time and run-time reject any path resolving outside the clone dir or outside the allowed roots. Whitelist against the discovered set; never trust the raw string. |

## Architecture

Five units, each independently testable.

### 1. Reader (server) — `modules/context`

A new server module exposing repo document discovery.

- **Glob helper** over `container.git.clonePathFor(repo)` matching `**/{specs,docs,insights}/**/*.md`. Roots configurable in `platform/config.ts` (default `['specs','docs','insights']`). Reuse the hand-rolled `walk` recursion pattern (as in `adapters/codeindex/ripgrep.ts:128`) — no new glob dependency. Honors an ignore set (`node_modules`, `.git`, etc.).
- **`GET /repos/:repoId/context`** → `SpecFile[]` (`{ path, size, updated_at }`, content omitted from the list). Matches the existing client hook target.
- **`GET /repos/:repoId/context/file?path=…`** (or content on demand) → single doc content for Preview. Path validated (see Security).
- **`POST /repos/:repoId/context/reindex`** → re-globs and returns the fresh list (stateless — no persistence).

### 2. Storage & data model (server)

- Migration `0016_attached_context_paths.sql`: `ALTER TABLE "agents" ADD COLUMN "attached_context_paths" jsonb;` and same for `"skills"` (nullable, no default — matching `evidence_files`). Generated with `pnpm db:generate`, applied with `pnpm db:migrate` (never auto-applied).
- `attachedContextPaths: jsonb('attached_context_paths').$type<string[]>()` on `schema/agents.ts` and `schema/skills.ts`.
- Thread `attached_context_paths: z.array(z.string()).nullish()` through: `Agent`/`Skill` DTOs (`contracts/knowledge.ts`), `toAgentDto`/`toSkillDto`, repository Insert/Update, service inputs, and the `PUT` route bodies (`UpdateAgentBody`, `UpdateSkillBody`). **Note:** the skill route bodies currently omit array fields entirely, so this must be added there to be editor-editable.
- **Versioning (agent only):** extend `AgentVersionConfig` (`contracts/knowledge.ts:218-228`), `snapshotVersion` (`repository.ts:149-168`), and `isConfigChange` (`helpers.ts:61-86`) so attached paths are part of the immutable snapshot and a change to them bumps the version.

### 3. Injection at run time (server) — `ReviewRunExecutor`

- New private `buildSpecsDigest(agent, repo)` in `run-executor.ts`, mirroring `buildCallersDigest` / `buildRepoMapDigest`:
  1. Compute the **effective set** = agent's own `attachedContextPaths` (in order) → paths inherited from the agent's enabled skills (skill order, then doc order) → dedup by path (first wins).
  2. **Pre-flight**: for each path, validate it is inside the clone and matches an allowed root; then confirm it exists on disk. Any failure → fail the run immediately with a precise error, before assembling the prompt or calling the LLM.
  3. Read each file via `container.git.readFile`. Return `{ specs: string[], specsRead: string[], tokensPerDoc }`.
- Pass `specs` into `reviewPullRequest`, and set `specs_read` (+ per-doc token size) in the trace. Populate `PromptAssembly.specs` (already flows from `outcome.assembly`).
- **Parity:** wire the same digest into the second engine caller — the A/B eval harness at `modules/agents/service.ts:242`.

### 4. Client surfaces

Data access via TanStack Query hooks in `lib/hooks/` (components never fetch — `client/CLAUDE.md` rule). Reuse `useContextFiles`; add link-mutation hooks mirroring `useAgentSkills`/`useSetAgentSkills`.

- **(a) Agent "Context" tab** — net-new tab. Touch `AgentEditor/constants.ts` (descriptor), `AgentEditor.tsx` (render branch), `agents/[id]/page.tsx:15` (`VALID_TABS`). dnd-kit sortable list mirroring `SkillsTab`: drag handle + checkbox + name + `specs/docs/insights` badge (local color map — no cross-feature import) + Filter input + per-row **Preview**. Add-doc picker mirrors `AddSkillPicker`. Inherited-from-skills docs rendered greyed/read-only (not reorderable, not removable here).
- **(b) Skill "Project context to use" section** — new `FormField` block in the flat `SkillEditor` form, same list UI.
- **(c) Project Context screen** — new `/context` page mirroring `SkillsListView` (`AppShell` + breadcrumb + header + filter + list + preview drawer). Enable the currently-`disabled` nav item and point `href` to `/context` — carefully, since `nav.ts` is under `vendor/`.
- **(d) Run-trace panel** — surface `specs_read` + token size in the run trace UI (the "Specs read" panel from the mockup).
- **Preview** everywhere reuses the `SkillPreviewDrawer` pattern + `Markdown` primitive. `kind` badge derived from path.

## Data flow

**Attach (author time):** UI reads `GET /repos/:id/context` → author toggles/reorders docs → `PUT /agents/:id` (or `/skills/:id`) with `attached_context_paths` → save-time validation rejects unknown/escaping paths (422) → agent version bumps.

**Run time:** `runOneAgent` → `buildSpecsDigest` computes effective set (frozen agent list from the run's agent config + **live** inherited skill paths + **live** file contents) → pre-flight validation → read files → inject into `## Project context` (untrusted-wrapped) → LLM → trace records `specs_read` + tokens.

**Frozen list, live contents:** re-running an old agent version replays that version's *own* attached-path list (from the snapshot), but resolves inherited skill paths and all file *contents* live — identical to how snapshotted skill *slugs* already resolve their current *bodies*. This keeps behavior consistent with the existing versioning model.

## Error handling & security

- **Path traversal (MUST).** Attached paths are client-supplied and read from disk. Save-time and run-time both: normalize the path, resolve against the clone root, and reject anything that escapes the clone dir or the allowed roots. Belt-and-suspenders: only accept paths present in the freshly-globbed discovered set. A `../../.devdigest/secrets.json` attempt must never be read.
- **Fail-the-run pre-flight.** Missing or escaping effective path → fail before LLM call, error names the path, trace records the failure. Cheap and diagnosable.
- **Save-time validation.** `PUT` bodies validate each path against the current discovered set → 422 on unknown paths, so most staleness is caught at edit time.
- **Empty states.** "No docs found" and "repo not cloned yet" handled distinctly in the reader and UI.
- **Symlinks.** The walk must not follow symlinks out of the clone (traversal vector).

## Testing strategy

- **Unit** (`reviewer-core` / server pure fns): glob helper (depth, roots, ignore set), `buildSpecsDigest` merge/dedup/order, path-traversal rejection (`../`, absolute, symlink-escape), token counting.
- **Integration** (`*.it.test.ts`, `fastify.inject()`): `GET /repos/:id/context` (list + not-cloned); `GET …/context/file` path validation; `PUT /agents/:id` + `/skills/:id` accept & validate paths and bump version; run-executor actually feeds the slot and populates `specs_read`; pre-flight fails cleanly on missing/escaping path.
- **Component** (React Testing Library): agent Context tab (attach / reorder / inherited-greyed / preview), skill section, Project Context screen (list / filter / preview).
- **Live check** (the brief's acceptance): attach a spec with an invariant (e.g. "module `api/` must not import `db/` directly") → open a violating PR → reviewer flags it citing the spec.

## Risks & tradeoffs

- **On-demand glob cost** on very large repos. Acceptable for v1 (manual attach, modest repos); persisted index is the documented future upgrade.
- **Fail-the-run strictness** can block reviews on a single renamed file. Mitigated by save-time validation and a precise, cheap pre-flight error. Deliberate — spec-as-contract is the L06 direction.
- **`vendor/` nav edit.** Enabling the nav item touches a do-not-touch zone; done minimally and called out in review.
- **Versioning touch-points.** Threading paths through the snapshot + bump predicate adds surface; mitigated by mirroring the exact existing skill/prompt pattern.

## Rollout plan (deferred to the EARS spec + writing-plans)

Phased so no single PR is unwieldy: (1) reader module + endpoint; (2) storage + migration + DTO/route threading + versioning; (3) run-time injection + trace + parity; (4) agent Context tab; (5) skill section + inheritance UI; (6) Project Context screen + nav enable; (7) run-trace panel; (8) live-check verification.

## Open questions

None at time of writing. Q1–Q7 resolved during brainstorming.

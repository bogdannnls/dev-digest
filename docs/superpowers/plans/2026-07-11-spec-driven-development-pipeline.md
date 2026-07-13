# Spec-Driven-Development Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit SDD pipeline to DevDigest — a `spec-creator` agent, a `writing-specs` skill, a repurposed `implementation-planner`, and a `/sdd` orchestration command+workflow.

**Architecture:** Prompt/config artifacts under `.claude/` (agents, skills, commands) plus one JS workflow. The workflow dispatches named agents via the harness `agent({ agentType })` capability. No product code changes; no `server/`/`client/` diff.

**Tech Stack:** Claude Code agents/skills/commands (Markdown + YAML frontmatter), workflow runtime JS (injected `agent`/`parallel`/`phase` globals — no imports).

**Design of record:** `docs/superpowers/specs/2026-07-11-spec-driven-development-pipeline-design.md`.

## Global Constraints

- Agent/skill/command files follow existing repo format: YAML frontmatter (`name`, `description`, `tools`, `model`) + system-prompt body. Commands use `description`-only frontmatter; the name comes from the filename.
- All prose in **English** (per global CLAUDE.md).
- Subagents cannot spawn subagents or invoke workflows — controller-only.
- Write-path scoping in agents is prompt-enforced, not sandboxed.
- Do not edit applied SQL migrations, `e2e/specs/*.flow.json`, `.github/workflows/*`, or `skills-lock.json` by hand (skills-lock is tooling-managed — see Task 1 Step 2).
- Repo uses `INSIGHTS.md`, not `LEARNINGS.md`. Active prose-spec location is `docs/superpowers/specs/`; SDD requirement specs (this pipeline) go to `<module>/specs/` (single-module) or root `specs/` (cross-cutting).
- Commit per task; do not push. Commit-message trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: `writing-specs` skill

**Files:**
- Create: `.claude/skills/writing-specs/SKILL.md`
- Create: `.claude/skills/writing-specs/references.md` (EARS "vague→better" examples + template rationale)

**Interfaces:**
- Produces: a skill named `writing-specs` (invocable via the Skill tool) consumed by `spec-creator` (Task 2) and `implementation-planner` (Task 4). Body must contain: the spec template (verbatim block from the design doc), the 6 requirement categories, the 5 EARS patterns, traceability rules (AC↔US↔module↔task ids), the per-AC verification-hint rule, the folder-scoped-INSIGHTS rule, the design-analysis checklist (gaps / corner-cases / inter-module comms / UX), untrusted-inputs handling, and the final self-check checklist.

- [ ] **Step 1: Write `SKILL.md` with frontmatter + body**

Frontmatter (match existing skill format — `name` + `description` only; no `model`, no `argument-hint`):

```yaml
---
name: writing-specs
description: Use when authoring or reviewing a Spec-Driven-Development requirement spec — writing EARS acceptance criteria, the SDD spec template, traceability, verification hints, and the spec self-check. Invoked by spec-creator and implementation-planner; usable directly by humans.
---
```

Body sections (author in full at execution time; content is specified by the design doc §Deliverable 2): `## The 6 requirement categories`, `## EARS: the 5 patterns`, `## Vague → EARS translation` (reference `references.md`), `## Spec template` (paste the verbatim template block from the design doc), `## Traceability`, `## Verification hints`, `## Folder-scoped INSIGHTS`, `## Design-analysis pass`, `## Untrusted inputs`, `## Final self-check`.

- [ ] **Step 2: Determine skills-lock.json handling**

Run: `git log --oneline -5 -- skills-lock.json` and `sed -n '1,40p' skills-lock.json` (read-only) to learn how entries are shaped and whether a generator script exists (`rg -l "skills-lock" package.json scripts .claude`).
Expected: either a documented generator command to run, or evidence entries are added manually. **If a generator exists, run it; if manual, add the entry following the existing shape. Do NOT hand-edit if the file is tool-owned — stop and report instead.**

- [ ] **Step 3: Verify skill is discoverable**

Run: `rg -n "name: writing-specs" .claude/skills/writing-specs/SKILL.md` and confirm the folder layout matches peers: `ls .claude/skills/writing-specs/`.
Expected: `SKILL.md` + `references.md` present; frontmatter name matches folder.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/writing-specs/ skills-lock.json
git commit -m 'feat(skills): add writing-specs skill (EARS + SDD spec template)'
```
(Only add `skills-lock.json` if Step 2 changed it.)

---

### Task 2: `spec-creator` agent

**Files:**
- Create: `.claude/agents/spec-creator.md`

**Interfaces:**
- Consumes: the `writing-specs` skill (Task 1).
- Produces: an agent `agentType: spec-creator`, dispatchable via the Task tool, that writes SDD specs to `<module>/specs/` or root `specs/`.

- [ ] **Step 1: Write frontmatter**

```yaml
---
name: spec-creator
description: Authors Spec-Driven-Development requirement specs (EARS acceptance criteria). Read + Write, write-scoped by prompt to <module>/specs/ (single-module) and root specs/ (cross-cutting). Interactive — emits [NEEDS CLARIFICATION] questions. Accepts pre-fed researcher findings + designs + extra requirements. Analyzes designs for gaps, corner cases, inter-module communication, and UX improvements. Does NOT write code, INSIGHTS.md, CLAUDE.md, or e2e flow specs; does NOT spawn subagents; no implementation detail in specs.
tools: Read, Grep, Glob, Edit, Write, Skill, Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git status:*), Bash(git blame:*), Bash(rg:*), Bash(find:*), Bash(fd:*), Bash(ls:*), Bash(tree:*), Bash(wc:*)
model: sonnet
---
```

- [ ] **Step 2: Write the body**

Author sections per design doc §Deliverable 1: role; hard rules (write-scope, no code, EARS-only, no subagent spawning); inputs (feature desc + designs + pre-fed researcher findings + requirements); the 5-step behavior (determine modules → folder-scoped context → design-analysis pass → write spec via `writing-specs` skill → run+record self-check); interview mode using `[NEEDS CLARIFICATION]`; a "What you do NOT do" section mirroring the fleet's style. Instruct it to **invoke the `writing-specs` skill first**. Filename convention: `<module>/specs/YYYY-MM-DD-<slug>-spec.md`.

- [ ] **Step 3: Verify frontmatter validity**

Run: `rg -n "^(name|tools|model):" .claude/agents/spec-creator.md`
Expected: `name: spec-creator`, a `tools:` line without `WebFetch`/`WebSearch`, `model: sonnet`.

- [ ] **Step 4: Commit**

```bash
git add .claude/agents/spec-creator.md
git commit -m 'feat(agents): add spec-creator agent for SDD requirement specs'
```

---

### Task 3: Align spec-location conventions

**Files:**
- Modify: `.claude/agents/doc-writer.md` (placement decision tree — add `<module>/specs/` as the SDD-spec destination owned by `spec-creator`; keep prose design docs in `docs/superpowers/specs/`)
- Modify: `server/CLAUDE.md`, `client/CLAUDE.md`, `reviewer-core/CLAUDE.md` (note: `<module>/specs/` holds SDD requirement specs authored by `spec-creator`)
- Modify: `CLAUDE.md` (root — clarify root `specs/` holds cross-cutting SDD specs)

**Interfaces:**
- Consumes: the write-scope decision from Task 2.
- Produces: a single non-contradictory convention: `doc-writer` → prose design docs in `docs/superpowers/specs/`; `spec-creator` → SDD specs in `<module>/specs/` (or root `specs/`).

- [ ] **Step 1: Locate every "specs/" convention statement**

Run: `rg -n "specs/" CLAUDE.md */CLAUDE.md .claude/agents/doc-writer.md`
Expected: the lines to reconcile (doc-writer placement tree; module CLAUDE.md spec notes; root CLAUDE.md line ~49).

- [ ] **Step 2: Edit doc-writer placement tree**

Replace the "legacy duplication" framing for `<module>/specs/` with: "`<module>/specs/` — SDD requirement specs authored by `spec-creator`; do not author these here, defer to that agent. Prose design docs (Mode B) stay in `docs/superpowers/specs/`."

- [ ] **Step 3: Edit the four CLAUDE.md files**

Add one line each pointing `<module>/specs/` (and root `specs/` for cross-cutting) at SDD specs owned by `spec-creator`.

- [ ] **Step 4: Verify no contradiction remains**

Run: `rg -n "legacy|deprecat" .claude/agents/doc-writer.md` and re-read the reconciled lines.
Expected: no wording that tells a reader NOT to use `<module>/specs/` while `spec-creator` is told to use it.

- [ ] **Step 5: Commit**

```bash
git add .claude/agents/doc-writer.md CLAUDE.md server/CLAUDE.md client/CLAUDE.md reviewer-core/CLAUDE.md
git commit -m 'docs(sdd): reconcile spec-location convention for spec-creator'
```

---

### Task 4: `planner` → `implementation-planner`

**Files:**
- Rename: `.claude/agents/planner.md` → `.claude/agents/implementation-planner.md`
- Modify: the renamed file (frontmatter `name:` + body)
- Modify: `.claude/agents/README.md` and any file referencing the `planner` agent by name (grep in Step 1)

**Interfaces:**
- Consumes: an approved SDD spec (from `spec-creator`) as primary input; the `writing-specs` skill (to read AC ids / traceability).
- Produces: an agent `agentType: implementation-planner` emitting the same Development-Plan contract as before, plus an `execution_mode: single|multi` annotation consumed by `/sdd` (Task 5).

- [ ] **Step 1: Find all references to `planner`**

Run: `rg -n "\bplanner\b" .claude/ docs/ --glob '!**/node_modules/**'`
Expected: list of prose references to update (README, doc-writer, plan-verifier, implementer, security/architecture reviewers).

- [ ] **Step 2: Rename the file**

```bash
git mv .claude/agents/planner.md .claude/agents/implementation-planner.md
```

- [ ] **Step 3: Edit frontmatter + body**

Set `name: implementation-planner`. Update `description` to state: consumes an approved spec, produces implementation plans only (no spec authoring), verifies AC coverage, recommends improvements, asks single-agent vs multi-agent. In the body: strip spec-authoring framing (the "structured, parseable specifications" line → "implementation plans"); add a **Requirement verification** step (every spec AC maps to a task; flag gaps); add an **Execution mode** step (ask single vs multi, annotate `execution_mode`, set `depends_on`/parallelizability); add **Token discipline** (lean on the spec, folder-scoped INSIGHTS only for touched modules + relevant root entries); instruct it to invoke the `writing-specs` skill to parse AC ids.

- [ ] **Step 4: Update prose references**

Edit each file from Step 1 so `planner` → `implementation-planner` where it names the agent. Do not change the meaning of Development-Plan contract references.

- [ ] **Step 5: Verify**

Run: `rg -n "\bplanner\b" .claude/ docs/ --glob '!**/node_modules/**'`
Expected: no stale bare `planner` agent references remain (only `implementation-planner`, or historical mentions in the dated design/plan docs which are acceptable).
Run: `rg -n "^name: implementation-planner" .claude/agents/implementation-planner.md` → matches.

- [ ] **Step 6: Commit**

```bash
git add .claude/agents/ docs/
git commit -m 'refactor(agents): repurpose planner as implementation-planner (plan-only)'
```

---

### Task 5: `/sdd` command + workflow

**Files:**
- Create: `.claude/commands/sdd.md`
- Create: `.claude/workflows/sdd.js`

**Interfaces:**
- Consumes: a Development Plan file (from `implementation-planner`); dispatches `implementer`, `plan-verifier`, `architecture-reviewer` by `agentType`.
- Produces: a structured run report `{ implemented, verify, review: {must, should}, fixes, remaining }`.

- [ ] **Step 1: Smoke-test `agentType` dispatch (de-risk the unproven capability)**

Create a throwaway `.claude/workflows/_smoke.js` that calls `await agent('Reply with the single word OK and nothing else.', { agentType: 'researcher', model: 'sonnet' })` and `log()`s the result. Invoke it via the Workflow tool (`name: '_smoke'`).
Expected: the named `researcher` agent runs and returns text. **If `agentType` is not honored, STOP** — fall back to building `/sdd` as a prose command that drives the main session to dispatch named agents via the Task tool, and note the change. Delete `_smoke.js` after.

- [ ] **Step 2: Write `.claude/commands/sdd.md`**

```markdown
---
description: Run the implement half of the SDD pipeline from a Development Plan — implement (multi/single), verify (gate), architecture-review, bounded fix loop. Does not commit.
---

Invoke the Workflow tool with `name: 'sdd'`, passing any provided plan path, spec path, designs, and extra requirements as args.

Report the returned summary: implemented tasks, plan-verifier verdicts, MUST/SHOULD review findings, fixes applied, and anything still unmet. Do not commit — hand back to the user.
```

- [ ] **Step 3: Write `.claude/workflows/sdd.js` skeleton**

Author the phases from design doc §Deliverable 4. Structural skeleton (fill prompts + parsing at execution time):

```js
// no imports — agent/parallel/phase/log are injected globals
export const meta = { name: 'sdd', description: 'SDD implement pipeline' }

export default async function sdd() {
  // Phase 0 — Preflight: resolve plan (args.planPath or latest docs/superpowers/plans/),
  //   parse task graph + execution_mode, load spec/designs/requirements as context.
  // Phase 1 — Implement: dispatch agentType:'implementer' per task.
  //   multi = parallel() within a dependency wave (disjoint files_to_touch -> shared tree);
  //   single = sequential. Force model:'sonnet'.
  // Phase 2 — Verify (gate): agentType:'plan-verifier', schema = VERDICT_SCHEMA.
  //   unmet/partial -> loop to Phase 1 for those tasks, max 2 waves.
  // Phase 3 — Review: agentType:'architecture-reviewer' on the diff, schema = FINDINGS_SCHEMA.
  //   test-writer NOT dispatched. Conditionally security/api-contract reviewer if diff
  //   touches auth/contracts.
  // Phase 4 — Fix loop: MUST findings -> agentType:'implementer', max 2 iterations.
  //   SHOULD surfaced only. Re-run plan-verifier if fixes substantial.
  // Phase 5 — Report: return { implemented, verify, review, fixes, remaining }.
}
```

- [ ] **Step 4: Validate JS parses**

Run: `node --check .claude/workflows/sdd.js`
Expected: no output (exit 0). (Injected globals are undefined at parse time but `--check` only validates syntax.)

- [ ] **Step 5: Dry-run the workflow against an existing plan**

Invoke the Workflow tool `name: 'sdd'` with a small existing plan (or a 1-task fixture). Confirm Phase 0 resolves the plan and Phase 1 dispatches `implementer` on sonnet.
Expected: the pipeline reaches at least Phase 2 and returns a structured summary. Capture any runtime error and fix.

- [ ] **Step 6: Commit**

```bash
git add .claude/commands/sdd.md .claude/workflows/sdd.js
git commit -m 'feat(sdd): add /sdd command + workflow orchestrating implement->verify->review'
```

---

## Self-Review

**Spec coverage** (against the design doc):
- Deliverable 1 (spec-creator) → Task 2 (+ convention alignment in Task 3). ✓
- Deliverable 2 (writing-specs skill) → Task 1. ✓
- Deliverable 3 (implementation-planner) → Task 4. ✓
- Deliverable 4 (/sdd command+workflow) → Task 5. ✓
- Deliverable 5 (workflow audit) → delivered in the design doc; no code task needed. ✓
- Risk "agentType unused in repo" → mitigated by Task 5 Step 1 smoke test with STOP-and-fallback. ✓
- Consequence "per-module specs conflict with doc-writer/CLAUDE.md" → Task 3. ✓

**Placeholder scan:** frontmatter and command/workflow skeletons are verbatim; prose-body sections point to the design doc's numbered deliverable for exact content (acceptable — the bodies are prompt prose authored at execution time, not code). No "TBD"/"handle edge cases" left in code steps.

**Type consistency:** agentType strings (`spec-creator`, `implementation-planner`, `implementer`, `plan-verifier`, `architecture-reviewer`, `researcher`) are used consistently; `execution_mode: single|multi` is produced in Task 4 and consumed in Task 5.

**Dependencies:** Task 1 → Tasks 2 & 4 (skill reference). Task 2 → Task 3 (convention). Task 4 → Task 5 (execution_mode). Task 5 Step 1 gates the rest of Task 5.

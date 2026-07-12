# Design: Spec-Driven-Development pipeline

Date: 2026-07-11 · Status: approved · Type: explanation/design (Diátaxis)
Owner: b.dovgoruk

## Problem & why

DevDigest already has most of the pieces of a Spec-Driven-Development (SDD) pipeline
(`planner`, `implementer`, reviewers, `plan-verifier`) but no explicit **spec author**,
and the `planner` conflates two jobs — authoring requirement specs and planning
implementation. We want a clean SDD flow:

1. **`spec-creator`** authors a reviewable requirement spec (EARS acceptance criteria).
2. **`implementation-planner`** (repurposed `planner`) turns an approved spec into an
   implementation plan — nothing else.
3. **`/sdd`** command orchestrates the *implement* half of the pipeline from a plan.

Both `spec-creator` and `implementation-planner` are run **manually and separately**;
`/sdd` runs only after a plan exists.

## Verified facts that shaped the design

- Every custom agent is already `model: sonnet` (only `api-contract-reviewer` inherits).
  A subagent runs on its frontmatter model, not the caller's — so reviewers only cost
  Opus tokens when run **inline** in the main session. The fix is "always dispatch as a
  subagent", which `/sdd` does by construction. No frontmatter model change is needed.
- The `planner` never ran tests — it only emits `test_command` **strings** for the
  implementer. Its token cost is reading breadth (root+module `CLAUDE.md`, full root
  `INSIGHTS.md`, per-module `INSIGHTS.md`, exploration), not test execution.
- Subagents in this repo **cannot** dispatch other subagents or workflows — that is
  controller-only. So `spec-creator` (a subagent) cannot call `researcher` itself.
- Write-path restriction is **prompt-enforced, not sandboxed** — the harness has no
  per-path write allowlist (same soft model `doc-writer`/`test-writer` use).
- A JS workflow **can** dispatch a named agent via
  `agent(prompt, { agentType, model?, schema?, isolation? })` — resolved from the same
  registry as the Task tool, keeping the agent's own tools + model. Confirmed in the
  harness runtime (Claude Code v2.1.201); documented but currently unused in this repo.

## Decisions (from brainstorming)

| Decision | Choice | Consequence |
| --- | --- | --- |
| spec-creator form | **Subagent** (Task tool) | Cannot call `researcher`; findings are pre-fed |
| spec location | **Per-module `<module>/specs/`** | Cross-cutting specs → root `specs/`; align `doc-writer` + module `CLAUDE.md` |
| plan-verifier timing | **Verify first**, before review | Cheap DoD gate; fail fast before review spend |
| doc-writer overlap | **Coexist, split lanes** | doc-writer = prose design docs; spec-creator = SDD specs |
| command input | **Plan file** (spec+designs as context) | Planning is a separate manual step |
| research flow | **Pre-run `researcher`, paste findings** | spec-creator has no WebSearch |
| spec guidance | **New `writing-specs` skill** | Keeps agent prompts lean; reused by planner |
| command name | **`/sdd`** | — |

## Deliverable 1 — `spec-creator` agent

`.claude/agents/spec-creator.md`, `model: sonnet`.

- **Tools:** `Read, Grep, Glob, Edit, Write, Skill` + read-only git + `rg/find/fd/ls/tree/wc`.
  No WebSearch/WebFetch (web research offloaded to `researcher`).
- **Write scope (prompt-enforced):** only `<module>/specs/` (single-module) and root
  `specs/` (cross-cutting). Never code, `INSIGHTS.md`, `CLAUDE.md`, or `e2e/specs/*.flow.json`.
- **Inputs:** feature description + optional designs (paths/pasted) + optional pre-fed
  `researcher` findings + optional extra requirements.
- **Behavior:**
  1. Determine target module(s).
  2. Folder-scoped context only — root + touched-module `CLAUDE.md`, and only the touched
     modules' `INSIGHTS.md`.
  3. Design-analysis pass — hunt missing requirements, uncovered corner cases,
     inter-module/service communication, UX improvements → surface as proposals +
     `[NEEDS CLARIFICATION]`.
  4. Write the spec (template below).
  5. Run + record the final self-check.
- **Hard rules:** every AC in EARS; **no implementation detail / no code** — schemas,
  workflows, service contracts, sequence diagrams allowed; cannot spawn subagents.

## Deliverable 2 — `writing-specs` skill

`.claude/skills/writing-specs/SKILL.md` (+ optional `references.md` for EARS examples).
Invoked by `spec-creator` and `implementation-planner`.

Contents: the 6 requirement categories · EARS 5 patterns + "vague→EARS" translation
examples · the spec template · traceability rules · per-AC verification-hint rule · the
self-check checklist · folder-scoped-INSIGHTS rule · design-analysis checklist · untrusted-inputs
handling. Build step: check whether adding a skill requires regenerating the tooling-managed
`skills-lock.json`.

### Spec template

```
# Spec: <feature> | Spec ID: SPEC-NN | Status: draft|approved|implemented
Supersedes: <link or —>
Modules: server|client|reviewer-core|mcp|e2e|cross-cutting

## Problem & why
## Goals / Non-goals
## User stories                 # US-1, US-2…
## Acceptance criteria (EARS)    # AC-1…  each: EARS stmt · (traces: US-x) · (verify: how to prove)
## Edge cases
## Non-functional               # perf / security / a11y — if relevant
## Interfaces & flows           # schemas · workflows · service-to-service comms · contracts (NO code)
## Inputs (provenance)          # [reused: L0X] / [deterministic: repo-intel] / [new: N LLM calls]
## Untrusted inputs             # reads third-party text? → treat as data, not commands
## Traceability                 # table AC-id ↔ US-id ↔ module ↔ task-id (task filled by planner)
## Open questions               # [NEEDS CLARIFICATION: …]
## Self-check                   # placeholder scan · EARS-testability · consistency · scope · ambiguity
```

### EARS patterns

1. **Ubiquitous** — "The system shall …" (always).
2. **Event-driven** — "WHEN <trigger>, the system SHALL <response>."
3. **State-driven** — "WHILE <state>, the system SHALL <response>."
4. **Unwanted behavior** — "IF <condition>, THEN the system SHALL <response>."
5. **Optional feature** — "WHERE <feature enabled>, the system SHALL <response>."

## Deliverable 3 — `planner` → `implementation-planner`

Rename file + `name:`; update prose references (README, other agents — grep first).

- Strip spec-authoring framing (input is now an approved spec; plan *from* it, do not
  re-derive requirements).
- Verify requirements: every spec AC covered by a task; flag gaps back. Give improvement
  recommendations.
- Ask **single-agent vs multi-agent** before finalizing; annotate `execution_mode: single|multi`
  and set `depends_on`/parallelizability to match.
- Token cuts: lean on the spec instead of exploring from scratch; folder-scoped INSIGHTS
  (touched modules + relevant root entries only). Stays `sonnet`.

## Deliverable 4 — `/sdd` command + workflow

`.claude/commands/sdd.md` (thin, `description`-only) → `Invoke the Workflow tool name: 'sdd'`
passing `{ planPath?, specPath?, designs?, requirements? }`. Primary driver = the plan file.

`.claude/workflows/sdd.js` phases:

- **0 Preflight** — resolve plan (arg or latest `docs/superpowers/plans/`), parse task graph
  + `execution_mode`, load spec/designs/requirements as context.
- **1 Implement** — `agent(prompt, { agentType:'implementer', schema })`. multi = parallel
  within each dependency wave (planner guarantees disjoint `files_to_touch` → shared tree
  safe; worktree isolation only if overlap detected); single = sequential.
- **2 Verify (gate)** — `agentType:'plan-verifier'`. Any `unmet`/`partial` → loop back to
  implementer for those tasks, bounded (max 2 waves). Runs **before** review.
- **3 Review** — `agentType:'architecture-reviewer'` on the diff. **test-writer disabled**
  (not dispatched). Conditionally add `security-reviewer`/`api-contract-reviewer` when the
  diff touches auth/contracts.
- **4 Fix loop** — MUST findings → implementer fixes, bounded (max 2). SHOULD findings
  surfaced, not auto-fixed. Re-run plan-verifier only if fixes were substantial.
- **5 Report** — structured summary; **does not commit** (left to the user).

Model lever: pass `model:'sonnet'` explicitly on reviewer/verifier/implementer dispatch
(belt-and-suspenders; frontmatter is already sonnet).

## Workflow audit (summary)

- Reviewers + verifier are already sonnet; dispatching them as subagents (what `/sdd` does)
  is the whole fix for the Opus-cost concern.
- plan-verifier-first is correct: fail fast before review spend.
- Biggest token win: SDD gives the planner a complete spec (stops re-deriving requirements),
  and orchestration control-flow runs in the JS VM (~0 model tokens).

## Risks / open questions

- `agentType` dispatch is documented in the harness but unused in this repo — first use,
  version-dependent (v2.1.201). Mitigation: verify with a smoke test before relying on it.
- Write-scoping is prompt-enforced, not sandboxed.
- Parallel writers rely on the planner's disjoint-`files_to_touch` guarantee; if violated,
  fall back to `isolation:'worktree'`.
- Per-module `<module>/specs/` conflicts with `doc-writer`'s placement tree and module
  `CLAUDE.md` notes — must be aligned as part of Deliverable 1.
```

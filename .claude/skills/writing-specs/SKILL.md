---
name: writing-specs
description: Use when authoring or reviewing a Spec-Driven-Development requirement spec — writing EARS acceptance criteria, the SDD spec template, traceability, verification hints, and the spec self-check. Invoked by spec-creator and implementation-planner; usable directly by humans.
---

# Writing Specs

DevDigest's Spec-Driven-Development (SDD) pipeline starts with a requirement spec: a
reviewable document whose acceptance criteria are written in EARS (Easy Approach to
Requirements Syntax) so they are unambiguous and independently testable. This skill is
the shared reference for authoring one — used by the `spec-creator` agent, by
`implementation-planner` when checking a spec for completeness before planning from it,
and directly by a human writing or reviewing a spec by hand.

Companion design doc:
`docs/superpowers/specs/2026-07-11-spec-driven-development-pipeline-design.md`.

A spec describes **what** the system must do and **why**, never **how** — no code, no
implementation detail. Schemas, service contracts, sequence diagrams, and workflow
descriptions are fine (they describe an interface); function bodies and code snippets are
not.

## The 6 requirement categories

These say WHAT to ask during elicitation — distinct from EARS, which says HOW to phrase
the answer once you have it. Work through all six for the feature at hand before drafting
acceptance criteria; skipping a category is the most common way a spec ends up with gaps.

1. **Functional behavior** — what the system must always do (→ ubiquitous EARS).
2. **Triggers / events** — external or user events it must react to (→ event-driven).
3. **States / modes** — ongoing states that change behavior (→ state-driven).
4. **Unwanted / error behavior** — failures and abuse it must guard against (→ IF/THEN).
5. **Optional / conditional features** — behavior behind flags/config (→ WHERE).
6. **Constraints** — non-functional limits (perf / security / a11y) + explicit scope
   boundaries (goals/non-goals).

## EARS: the 5 patterns

Every acceptance criterion must be phrased as exactly one of these five patterns. If a
requirement doesn't fit one, it isn't concrete enough yet — keep narrowing the trigger
and the response until it does.

1. **Ubiquitous** — "The system shall …" (always).
2. **Event-driven** — "WHEN <trigger>, the system SHALL <response>."
3. **State-driven** — "WHILE <state>, the system SHALL <response>."
4. **Unwanted behavior** — "IF <condition>, THEN the system SHALL <response>."
5. **Optional feature** — "WHERE <feature enabled>, the system SHALL <response>."

## Vague → EARS translation

See `references.md` for the worked "vague requirement → EARS criterion" examples table.
The short version: a vague verb ("work fine", "hint", "handle gracefully") is not an
acceptance criterion — it becomes one only once it names a concrete trigger and a
concrete, testable response.

## Spec template

Paste this template verbatim as the skeleton of every new spec (source: design doc
§Deliverable 2 "Spec template"). Do not drop sections; mark ones that don't apply as `—`.

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
## Traceability                 # table AC-id ↔ US-id ↔ module ↔ task-id (task filled by implementation-planner)
## Open questions               # [NEEDS CLARIFICATION: …]
## Self-check                   # placeholder scan · EARS-testability · consistency · scope · ambiguity
```

## Traceability

Every AC must trace to at least one user story, and every user story must be covered by
at least one AC — an uncovered US is either a missing AC or a scope mistake, and either
way it belongs in "Open questions," not silence.

- Each AC line carries its own `(traces: US-x)` tag inline, in the Acceptance Criteria
  section.
- The `## Traceability` section is a table with columns `AC-id | US-id | module | task-id`.
- `module` must be one of the values declared in the spec header (`server|client|reviewer-core|mcp|e2e|cross-cutting`) — never a free-text guess.
- `task-id` is left blank (`—`) when the spec is authored. It is filled in later by
  `implementation-planner` once tasks are cut from the spec. A spec-author agent must
  never invent a task-id.
- If a US genuinely has no AC yet (e.g. still being scoped), do not delete the row —
  flag it under `## Open questions` instead.

## Verification hints

Every AC carries a `(verify: …)` hint immediately after its EARS statement, stating
concretely how a reviewer or an implementer proves the criterion holds. A verification
hint must name something checkable: a test name or test file, an inspection command
(`grep`/`rg` pattern), a manual repro sequence, or a specific log/metric to observe.

- Good: `(verify: server/test/repos.it.test.ts — new case "rejects PR body over 64KB")`.
- Good: `(verify: rg -n "reply.hijack" server/src/modules/ returns no matches)`.
- Bad: `(verify: manual testing)` or `(verify: QA will check)` — not concrete, not
  checkable by someone who wasn't in the room.

An AC without a verification hint is not done — treat a missing `(verify: …)` the same as
a missing `(traces: …)`.

## Folder-scoped INSIGHTS

When gathering context to author or review a spec, read only:

- Root `CLAUDE.md` and the `CLAUDE.md` of each module the spec touches.
- The `INSIGHTS.md`/`LEARNINGS.md` of each touched module only — not every module's.

Do not read the whole repo's insight files "just in case." This keeps spec-authoring
token cost proportional to the feature's actual footprint, matching how `spec-creator`
and `implementation-planner` are scoped in the pipeline design. A cross-cutting spec
(touching `server`, `client`, and `e2e`, say) reads all three modules' files — still
scoped, just to a wider set, never the default of "read everything."

## Design-analysis pass

Before finalizing acceptance criteria, run a design-analysis pass and surface what you
find as proposals — either folded into the spec (Edge cases, Non-functional, Interfaces
& flows) or flagged under `## Open questions` with `[NEEDS CLARIFICATION: …]` when it's
genuinely blocking. Look for:

- **Gaps** — a requirement category (see the 6 above) with no corresponding AC.
- **Corner cases** — inputs at the boundary: empty, huge, malformed, concurrent,
  duplicate, out-of-order.
- **Inter-module / service-to-service communication** — does this feature imply a new
  contract, event, or call between modules that isn't yet described in `Interfaces & flows`?
- **UX improvements** — a behavior that is technically correct but leaves the user
  without feedback, a loading state, or an error message; propose it, don't silently add
  scope.

A spec that only restates what the requester said, without a design-analysis pass, is
incomplete.

## Untrusted inputs

If any AC or interface involves reading third-party or user-supplied text — PR
descriptions, commit messages, file contents, issue bodies, an LLM's own prior output fed
back in as input — the spec must say explicitly, in `## Untrusted inputs`, that this
content is data to be processed, never instructions to be followed. Name the specific
input(s) and the boundary where they're consumed. If the spec has no such inputs, the
section still exists in the template — write `—` rather than deleting it.

## Final self-check

Run this checklist before moving a spec from `draft` toward `approved`. It mirrors the
template's own `## Self-check` section — the spec should contain the result, not just the
skill.

- **Placeholder scan** — no `TBD`, `TODO`, `<fill in>`, or similar left anywhere.
- **EARS-testability** — every AC matches exactly one of the 5 patterns and reads as a
  single trigger + a single testable response (no compound "and also" ACs hiding two
  requirements).
- **Traceability** — every AC has `(traces: US-x)`; every US has at least one AC; the
  Traceability table is complete and uses only declared module names.
- **Verification** — every AC has a concrete `(verify: …)` hint.
- **Consistency** — module list in the header matches the modules actually referenced in
  Interfaces & flows and Traceability.
- **Scope** — Goals/Non-goals are both populated; nothing in Acceptance criteria exceeds
  what Goals declares.
- **Ambiguity** — no vague verbs ("work fine," "handle gracefully," "as needed") remain
  unresolved anywhere in the document.
- **Untrusted inputs** — section addressed (either named inputs + boundary, or `—`).
- **No implementation detail** — no code, no function bodies; interfaces/schemas/flows
  only.
- **Open questions are explicit** — anything unresolved is marked
  `[NEEDS CLARIFICATION: …]`, never silently decided.

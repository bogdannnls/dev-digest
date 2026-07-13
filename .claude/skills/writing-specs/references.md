# References: Vague → EARS translation

Worked examples of turning a vague, unverifiable requirement into an EARS acceptance
criterion. Used by `writing-specs`; source of truth for the wording is the SDD pipeline
design doc (`docs/superpowers/specs/2026-07-11-spec-driven-development-pipeline-design.md`).

| Vague requirement | EARS criterion |
| --- | --- |
| "Should work fine on large repos" | WHEN a repository exceeds the indexing threshold, the system SHALL generate the overview from deterministic facts only, without full file reads. |
| "Shouldn't crash if the model is unavailable" | IF a structured model call fails, THEN the system SHALL render a deterministic overview skeleton with the reason instead of an error. |
| "Should hint where to start reading" | The system SHALL order the reading-path by file rank from the import graph, not alphabetically or by date. |

The point these illustrate: a vague verb ("work fine", "hint") becomes a concrete trigger
+ concrete, testable response.

## Why this matters

Each row above shows the same failure mode: the vague phrasing sounds reasonable but
can't be checked. Nobody can write a test for "should work fine" — there's no trigger and
no observable pass/fail condition. The EARS rewrite fixes this in two moves every time:

1. **Name the trigger.** "on large repos" becomes "WHEN a repository exceeds the indexing
   threshold" — a condition someone can construct in a test fixture.
2. **Name the response as an observable, falsifiable behavior.** "work fine" becomes
   "generate the overview from deterministic facts only, without full file reads" — a
   claim you can grep for or assert on directly, not a vibe.

The same move works in reverse as a smell-detector: if you can't tell what test would
fail when an AC is violated, the AC is still vague, no matter how official its EARS
keywords (`WHEN`, `SHALL`, `IF/THEN`) look.

## Template rationale (short)

The spec template's section order is deliberate, not arbitrary:

- **Problem & why** and **Goals / Non-goals** come first because every later section is
  scoped by them — Acceptance criteria that exceed Goals is a scope-creep smell the
  self-check explicitly checks for.
- **User stories** precede **Acceptance criteria** because ACs must trace to a story, not
  the other way around; writing ACs first tends to produce criteria that trace to nothing.
- **Traceability** is its own section (not folded into Acceptance criteria) so an
  implementation-planner can scan one table for AC↔US↔module↔task coverage instead of
  parsing prose.
- **Untrusted inputs** is a mandatory section, not a footnote, because it is the one place
  in a spec-driven pipeline where a requirement doc itself might later be consumed by an
  agent — third-party text described here must be marked as data up front, not discovered
  as a gap during implementation.
- **Self-check** closes the template so the spec carries its own completion evidence,
  rather than that evidence living only in a reviewer's head.

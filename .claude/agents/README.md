# Subagents — design notes

This folder holds custom subagent definitions for Claude Code in this repo. Each `*.md` file is a self-contained agent: frontmatter (name, description, tools, model) plus a system prompt.

This README documents **why** the custom agents in this folder — `researcher`, `planner`, `implementer`, `test-writer`, `architecture-reviewer`, `plan-verifier`, `doc-writer` — are shaped the way they are, and links the practices they encode back to primary sources. It is design documentation, not a usage tutorial.

## Agents in this folder

| Agent | Model | Read/Write | Main purpose |
|---|---|---|---|
| `api-contract-reviewer` | inherit | read-only | Adversarial reviewer for public-API contract regressions (breaking changes, response-schema drift, semver, deprecation). Pre-existing; not covered in this document. |
| `researcher` | `sonnet` | read-only | Finds information in the codebase or on the public web and returns structured, cited findings. Interview-mode for vague prompts. Does not invoke `deep-research`. |
| `planner` | `sonnet` | read-only | Produces a **Development Plan** — a parseable, task-graph document that names files, skills, and verification commands. The plan is the contract consumed by `implementer`. |
| `implementer` | `sonnet` | read + write within task scope | Executes **one** task from a Development Plan. Runs the self-check loop (typecheck → tests → lint) up to 3 iterations. Does not commit, does not review architecturally. Designed for parallel dispatch on disjoint tasks. |
| `test-writer` | `sonnet` | read + write, scoped to test files | Writes and iterates tests (unit / component / integration) one-at-a-time with a TDD-checkpoint loop. Uses `fastify.inject()` for backend routes, RTL for UI. Refuses to weaken assertions to make tests pass; refuses to mock the unit under test. Invoked only on explicit request. |
| `architecture-reviewer` | `sonnet` | read-only | Reviews an uncommitted diff (or an explicit range) against onion/UI architecture rules and contract discipline. MUST/SHOULD findings with `file:line` + verbatim excerpt + `Fix:`. Complements — does not replace — `api-contract-reviewer`. |
| `plan-verifier` | `sonnet` | read-only (runs tests, no code edits) | Verifies task-by-task that a Development Plan actually landed in the diff. Per-task verdict `met` / `partial` / `unmet` with cited evidence. Re-derives every verdict — never trusts an implementer's self-report. Novel pattern with no external precedent. |
| `doc-writer` | `sonnet` | read + write, scoped to documentation files | Writes docs in three modes: reverse-engineer from code, plan → spec, or notes → doc. Classifies every doc per Diátaxis, verifies every reference before finalizing (anti-staleness), refuses to write slop that would just restate well-typed code. Never edits `INSIGHTS.md`/`LEARNINGS.md`. |

## Intended workflow

```
research?  →  plan  →  implement (× N in parallel)  →  /pr-self-review  →  commit
(optional)     ↑              ↑
             read INSIGHTS   read task-local INSIGHTS
```

- `researcher` is optional — used when the goal requires facts the planner doesn't already know (library docs, prior art).
- `planner` reads project context (`CLAUDE.md`, `INSIGHTS.md`) and emits one plan.
- Each `implementer` executes exactly one task from that plan; multiple can run in parallel on disjoint task ids.
- Architectural review is delegated to the existing `/pr-self-review` workflow, which the *controller* runs — not the implementer.

## Design principles and their sources

### 1. Planner-executor split; the plan is a structured artifact
Anthropic's harness uses a Planner–Generator–Evaluator topology where the planner never writes code and communicates with downstream agents via a shared file with clearly delimited sections. Claude Code's official plan mode prescribes an explore → plan → implement → commit flow, with the plan naming the files and interfaces involved and ending with an end-to-end verification step.

- Anthropic Engineering — Harness design for long-running application development. https://www.anthropic.com/engineering/harness-design-long-running-apps
- Claude Code — Best practices. https://code.claude.com/docs/en/best-practices

Encoded in: `planner.md` (Output format section) and `implementer.md` (Input contract section).

### 2. Handoff via structured contract, not free-form prose
Aider's architect mode uses free-form natural language between architect and editor. Anthropic's harness uses a structured spec. We chose structured, because parallel implementers need to consume plan tasks independently — each task is a self-contained object with `files_to_touch`, `skills_to_apply`, `insights_to_read`, `test_command`, `definition_of_done`.

- Aider — Separating code reasoning and editing. https://aider.chat/2024/09/26/architect.html

Encoded in: the `Task graph` section of the planner's output template.

### 3. Interview mode ("grill-me" / Active Task Disambiguation)
Both academic and practitioner literature describe the same anti-pattern: agents that silently proceed on incomplete context produce "outputs that look plausible but are incorrect." The counter-pattern is a bounded pre-flight clarification step — 1–3 focused questions in a single message, then commit and act.

- Miles K. — When agents learn to ask: Active questioning in agentic AI. https://medium.com/@milesk_33/when-agents-learn-to-ask-active-questioning-in-agentic-ai-f9088e249cf7
- Kilo Blog — Architect Agent Uses Grill-Me to Ask Better Questions. https://blog.kilo.ai/p/architect-agent-uses-grill-me-to-create-plan
- Claude Code — Best practices (Let Claude interview you). https://code.claude.com/docs/en/best-practices

Encoded in: identical `Interview mode` sections in `researcher.md`, `planner.md`.

### 4. Tool allowlist as the segregation mechanism
Claude Code subagent frontmatter uses the `tools:` field as an explicit allowlist. Restricted `Bash(<prefix>:*)` entries are enforced at the harness layer, not at prompt layer — much stronger than trusting the model to follow a rule.

- Claude Code — Create custom subagents. https://code.claude.com/docs/en/sub-agents

Encoded in: every agent in this folder. Compare `researcher.md` (read-only Bash prefixes) with `implementer.md` (adds build/test prefixes, still excludes `git commit`, `git push`, `pnpm install`, `rm`).

### 5. Prompt-enforced scope, because there is no per-subagent `cwd`
Claude Code has no `cwd` or directory sandbox for subagents — a documented gap (GitHub issue #31940). Domain restrictions ("this agent may only touch `client/`") are prompt-enforced, not harness-enforced. This is why the planner names `files_to_touch` per task and the implementer refuses to expand scope.

- GitHub issue — anthropics/claude-code#31940 (per-subagent `cwd`). https://github.com/anthropics/claude-code/issues/31940

Encoded in: `implementer.md` — the "Stay in scope" rule and the `blocked: scope-creep` return path.

### 6. Self-check loop = typecheck + tests + lint; nothing more
Claude Code docs describe the implementer's check as a pass/fail signal — the only reliable stop condition. A reviewer prompted to find gaps will almost always find some, so implementer self-review MUST be correctness-focused and stops the moment the check goes green. Adversarial review runs in a **separate fresh subagent context**.

- Claude Code — Best practices (self-check, review). https://code.claude.com/docs/en/best-practices

Encoded in: `implementer.md` — the 3-iteration self-check loop and the explicit "do not review architecturally" rule. Adversarial review is delegated to this repo's `/pr-self-review` workflow.

### 7. Hierarchical, just-in-time context loading
Human-curated context files improve task success by roughly 4 percentage points; LLM-generated ones decrease it by roughly 3% while increasing cost by 20%. Files should stay under 150–200 lines; large context bloats reduce accuracy. Sub-directory files are loaded on-demand when the agent enters that directory.

- Augment Code — How to Build Your AGENTS.md (2026). https://www.augmentcode.com/guides/how-to-build-agents-md
- Claude Code — Best practices (memory hierarchy). https://code.claude.com/docs/en/best-practices

Encoded in: `planner.md` — the planner reads root `INSIGHTS.md` + touched-module `INSIGHTS.md`, filters relevant entries into the plan's `Cross-cutting insights` section, and lists per-module `INSIGHTS.md` paths in each task's `insights_to_read` field so the implementer rereads them on arrival.

### 8. Honest "not found" > fabricated results
Every research and reporting template in this folder has an explicit `Gaps` section. Sources on the web are tagged `read in full` / `read partial` / `search snippet only` so the caller can weigh reliability. Confidence is stated with a one-line reason.

- Practitioner consensus, no single primary source. Reinforced by every reviewed harness's warnings about hallucinated citations.

Encoded in: `researcher.md` — both output templates (`Gaps / not found`, `Confidence`, source `status:` tags).

### 9. Verification by re-derivation, not self-report
When one agent's job is to check another agent's work, agreement bias creeps in — the checker tends to accept the earlier claim rather than test it. The counter is to grade each dimension independently with an isolated judge, and to make the judge re-derive its verdict from primary evidence (the diff, a test run) rather than from the prior agent's self-reported status. MT-Bench (Zheng et al., NeurIPS 2023) documents the bias; Anthropic's evals-engineering post is the shortest actionable prescription.

- Anthropic Engineering — Demystifying evals for AI agents. https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Zheng et al. — Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena (NeurIPS 2023). https://arxiv.org/abs/2306.05685

Encoded in: `plan-verifier.md` (re-derive verdicts from the diff, ignore any `Implementer report` status field; per-dimension `met`/`partial`/`unmet` rather than one holistic verdict) and `architecture-reviewer.md` (independent grader per applicable skill, no holistic "looks fine" pass).

## Project-specific constraints encoded

These are DevDigest-specific facts that shape the agents:

- **`INSIGHTS.md`, not `LEARNINGS.md`.** This repo uses `INSIGHTS.md` at the root and inside each module (`server/`, `client/`, `reviewer-core/`, `e2e/`). The `engineering-insights` skill's canonical target is `LEARNINGS.md`; agents in this folder override that to write `INSIGHTS.md`.
- **`/pr-self-review` only sees the uncommitted diff.** Documented in `INSIGHTS.md` (root, 2026-06-24). The implementer therefore does not commit — it leaves changes uncommitted so the controller can run the review before deciding commit boundaries.
- **`Workflow` and `Agent` tools are controller-only.** Subagents cannot invoke workflows or spawn other agents. Both `planner.md` and `implementer.md` state this explicitly to prevent hallucinated dispatch.
- **`server/src/vendor/shared/contracts/` is mirrored in `client/`.** Contract changes must touch both sides atomically. The planner tags such tasks `target_module: cross-cutting` and lists both paths in `files_to_touch`.
- **`reviewer-core/` uses `npm`, everything else uses `pnpm`.** The planner's Verification commands section and the implementer's Bash allowlist reflect this.
- **`*.it.test.ts` = integration tests, need Docker.** The implementer runs them only when the task explicitly requires them; the default self-check runs unit tests with `--exclude '**/*.it.test.ts'`.
- **`e2e/specs/*.flow.json` is a sensitive zone.** Marked in the root `CLAUDE.md`. Any e2e task must be explicit; the planner is instructed to flag it.

## Not covered / caveats

- **No live validation.** These agents were designed against documented best practices and project constraints. They have not been exercised end-to-end in a real dispatch chain at the time of writing. First real runs are also the validation — expect small prompt refinements as edge cases surface.
- **Task-object serialization.** Claude Code dispatches subagents with a single string prompt; there is no formal task-envelope validation. The planner's output template and the implementer's input contract are the only enforcement. If they drift, the system silently degrades.
- **Skill invocation reliability.** `implementer.md` grants the `Skill` tool and instructs explicit `Skill(<name>)` calls. If the harness rejects granting `Skill` to a subagent, skills fall back to natural-language reference via their descriptions — degraded but not broken.
- **This document does not replace individual agent files.** Each agent's `.md` file is authoritative for its own behavior. This README documents the shared design rationale.

## Change log

- 2026-07-04 — Initial version. Documents `researcher`, `planner`, `implementer` as designed on branch `l03`.
- 2026-07-04 — Second batch on branch `l03`. Added `test-writer`, `architecture-reviewer`, `plan-verifier`, `doc-writer`. Introduced principle §9 (verification by re-derivation, not self-report — encoded in `plan-verifier` and `architecture-reviewer`). `architecture-reviewer` deliberately kept separate from the pre-existing `api-contract-reviewer` — one is broad (onion/UI + contracts conditionally), the other is contract-only and adversarial. `test-writer` and `doc-writer` write-scoping is prompt-enforced (per §5) since Claude Code has no glob-scoped Edit/Write allowlist. Sources for the new agents: Anthropic "How Anthropic teams use Claude Code" and "Effective context engineering for AI agents" (test-writer TDD-checkpoint + JIT context); Kent C. Dodds' Testing Trophy (test-writer classification bias); Fastify Testing guide + Martin Fowler "Mocks Aren't Stubs" (mocking policy); Anthropic `/code-review` command + Code Review docs "verification bar" (architecture-reviewer scope + citation discipline); Anthropic "Demystifying evals for AI agents" + MT-Bench (§9 anti-sycophancy); Diátaxis (doc-writer classification); Mintlify "AI can write your docs, but should it?" + Eric Holscher "'My Code is Self-Documenting'" (doc-writer anti-slop); softaworks/agent-toolkit c4-architecture skill heuristic (doc-writer diagram-type selection). Full source list embedded in each agent's `.md`.

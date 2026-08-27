# Demo runbook — Eval Pipeline (L06)

What the submission checklist asks for, and the exact sequence that produces it.

Deliverables:
1. `specs/eval-pipeline.md` in the specs folder
2. `pnpm verify:l06` green
3. a screenshot comparing two runs made with different prompts
4. a screencast of the end-to-end scenario, narrated

---

## 0. Environment

Local Postgres runs on **5433** on this machine, not the default 5432 — port 5432 is held
by an unrelated container. `docker-compose.yml` reads `${DEVDIGEST_PG_PORT:-5432}`, and
the repo-root `.env` (gitignored) pins 5433 locally. Teammates cloning the repo still get
5432.

```bash
docker compose up -d && cd server && pnpm db:migrate
```

Then the stack:

```bash
./scripts/dev.sh
```

An LLM provider key must be configured in settings — an eval run makes one real LLM call
per case. Only the *scoring* is LLM-free.

---

## 1. Build the dataset (the one manual prerequisite)

The dataset is your own accept/dismiss history, exactly as the assignment intends. As of
2026-08-25 the local DB holds 97 findings across 5 agents but only **1 accepted and 0
dismissed** — so the decisions still have to be made.

Pick ONE agent to be the subject (Test Quality Reviewer has the most findings, 28), open
its PRs, and:

- Accept at least 5 findings you agree with → each becomes a `must_find` case.
- Dismiss at least 3 findings you consider noise → each becomes a `must_not_flag` case.

Both kinds must be represented; the acceptance criteria name both explicitly.

Then, on each decided finding, click **Turn into eval case**. Target: **at least 8 cases**
on that one agent. The Case Editor covers any shortfall — a hand-written case lives in the
same set and runs through the same route.

Every finding's file has a stored `pr_files.patch`, so case creation is fully offline: no
GitHub call, no clone.

---

## 2. Baseline run

Agents → your agent → **Evals** tab → **Run all evals**. Record recall / precision /
citation accuracy. This is run #1, against the current system prompt.

---

## 3. Improved prompt

Config tab → edit the system prompt in the direction you expect to help (for example, make
the citation requirement explicit, or narrow the categories the agent is allowed to
report). Save — this bumps `agents.version` and snapshots the config into
`agent_versions`.

Run the evals again. This is run #2.

Eval Dashboard → your agent → tick both runs → **Compare**. The modal shows the metric
deltas and the system-prompt diff side by side. **This is screenshot #3 of the
checklist.**

---

## 4. Deliberate sabotage (the sensitivity test)

Edit the system prompt again, this time to make it noisy on purpose — the reliable lever
is an instruction that manufactures findings, e.g. "flag every unused import as a
suggestion" or "always return at least 5 findings".

Run the evals a third time. Precision should fall visibly: under the strict definition
(contract section 3.3) precision is `TP / all findings produced`, so every manufactured
finding lands straight in the denominator with nothing in the numerator.

The trend chart on the Eval Dashboard shows all three runs, which makes the story readable
in one frame.

Restore the good prompt afterwards.

---

## 5. Verification gate

```bash
cd server && pnpm verify:l06
```

Hermetic: no DB, no network, no LLM. Its hermeticity is what proves the "scoring makes no
LLM call" criterion — the test could not pass otherwise.

---

## 6. Screencast

Narrate why, not just what. One take, roughly this order:

1. A finding you accepted, and why → click **Turn into eval case** → show that it became
   `must_find` at that file and line range.
2. A finding you dismissed → the same click → show it became `must_not_flag`. Say the
   thing that matters: the dataset is your review decisions, not invented scenarios.
3. The Evals tab with the full set → **Run all evals** → the three metrics.
4. Change the system prompt, run again, open the comparison. Read the deltas aloud and say
   which direction you expected.
5. The sabotage run and the precision drop. Name the mechanism: noise enters the precision
   denominator and nothing enters its numerator.
6. `pnpm verify:l06` in a terminal, and one sentence on why scoring needs no judge model:
   the expectation is a file and a line range, so a code-level overlap check settles it.

---

## Run log — 2026-08-25, executed end to end

The sequence above was run against the local stack (Postgres 5433, API 4001, web 3000)
with real `claude-sonnet-4-6` calls. Recorded here because the outcome contradicted the
hypothesis, and that is the part worth keeping.

### Dataset

Subject agent: **Test Quality Reviewer** (`2a3de406`). Ten cases, built from real review
decisions on its own findings:

- **6 `must_find`** — findings naming a concrete, mechanical defect in the test itself:
  wall-clock-dependent assertions, mutable state shared across cases, a spy-count
  assertion pinned to one of three calls, dead fake-timer scaffolding.
- **4 `must_not_flag`** — findings that only observe a coverage gap ("edge case X is not
  tested"). No defect is named, so the agent re-reporting them is noise by definition.

The split is the editorial policy the eval encodes: *a coverage gap is not a defect*.

### Results

| Run | Agent version | Recall | Precision | Citation | Traces |
|-----|---------------|--------|-----------|----------|--------|
| 1 — baseline           | v2 | 67% | 8%  | 100% | 4/10 |
| 2 — "improved" prompt  | v3 | 17% | 10% | 100% | 3/10 |
| 3 — corrected prompt   | v4 | 67% | 13% | 100% | 4/10 |

### What actually happened

Run 2's prompt did two things at once: it banned coverage-gap reporting *and* capped
output at three findings. The ban worked — two `must_not_flag` cases went to zero findings
and started passing. The cap did not: the model returned exactly one finding per case, and
usually not the expected one. Recall collapsed from 67% to 17% while precision moved only
two points, because true positives fell almost as fast as the total.

Run 3 kept the ban, dropped the cap, and named the four defect classes explicitly with an
instruction to report every instance of each. Recall returned to baseline and precision
finished five points above it.

The useful part is run 2. It reads as an obvious improvement — more specific, more
disciplined, less noisy — and it is a 50-point recall regression. Nothing short of running
the set would have shown that; the prompt diff alone argues the opposite. This is the
regression protection the pipeline exists for, demonstrated against itself rather than
against a contrived example.

Precision is low in absolute terms across all three runs because it is defined strictly
(contract §3.3): every finding the agent produces lands in the denominator, and each case
supplies only one expected finding. The metric is comparable between runs, which is what
it is for; it is not an accuracy score.

The agent is left on **v4**. Runs 1–3 and their prompts stay in `eval_run_batches`, so the
comparison is reproducible from the dashboard without re-running anything.

### Artifacts

- `screenshots/compare-baseline-vs-improved.png` — v2 vs v4, precision +5pp. Checklist item 3.
- `screenshots/compare-baseline-vs-regression.png` — v2 vs v3, the caught regression.
- `screenshots/agent-dashboard-trend.png` — all three runs, the recall dip visible as a V.
- `screenshots/agent-evals-tab.png` — the ten-case set with both expectation kinds.

Still owner-only: **the narrated screencast (step 6)**. Everything it needs to show is now
standing data — the cases exist, the three runs exist, the comparison opens from the
dashboard.

---

## Run 4 — the sensitivity test (assignment point 7)

Run on 2026-08-27 against the set as it stood then: **12 cases** (8 `must_find`,
4 `must_not_flag`) — two more than runs 1–3, so the comparable baseline is the 12-case
v4 run, not the original 10-case one.

The prompt was sabotaged deliberately, in the one direction that manufactures findings
without breaking citations: a floor of five findings per diff, plus an explicit licence to
report unused imports, unclear names, missing comments and hypothetical assertion
improvements when real defects run out. Citations were still required to point at lines
inside the diff, so the noise survives the grounding gate and lands in precision's
denominator rather than being dropped before it counts.

| Run | Version | Recall | Precision | Citation | Traces | Findings produced |
|-----|---------|--------|-----------|----------|--------|-------------------|
| baseline (same set) | v4 | 63% | 16% | 100% | 5/12 | 31 |
| sabotaged           | v5 | 88% | **6%**  | 100% | 7/12 | **111** |

### What the numbers say

Findings tripled, 31 → 111. True positives went 5 → 7. Precision is `TP / all findings`,
so the 80 extra findings entered the denominator and contributed two to the numerator:
16% → 6%.

Recall went **up**, not down, and that is the more instructive half. Spraying findings
across every diff hits more `must_find` targets by accident — 5/8 became 7/8. An agent
optimised for recall alone would score this prompt as an improvement. Only precision
exposes it, which is exactly why the assignment asks for both and why the dismissed
findings earn their place in the set.

`must_not_flag` stayed 0/4 in both runs. Those cases fail because this agent reports
something in those line ranges under either prompt; the sabotage did not make them worse
because they had nothing left to lose.

Citation accuracy stayed at 100%: the manufactured findings cited real lines. That is the
intended shape of the test — it isolates precision instead of confounding it with
grounding failures.

The good prompt was restored immediately afterwards (agent v6, byte-identical to v4).
Runs 1–5 and their prompts remain in `eval_run_batches`, so the whole story replays from
the dashboard without re-running anything.

Screenshot: `screenshots/compare-good-vs-noisy.png`.

### Two things visible in that screenshot worth knowing before recording

The regression banner at the top reads *"recall dropped by 0.13; precision dropped by
0.27"*, which matches neither column in the modal. It compares the newest batch against
the immediately preceding one — and that predecessor is a single-case run, a different
denominator entirely. The modal's `-10%` is the honest 12-case comparison; the banner is
comparing across case sets.

The comparison modal itself reports **Recall +25% / Precision -10%**, since it orders the
older run as `a`.

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

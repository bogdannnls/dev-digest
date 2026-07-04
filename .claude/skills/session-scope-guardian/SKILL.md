---
name: session-scope-guardian
description: Use at the start of processing any new user message OR when accepting a new dispatch task as a subagent. Also trigger if the last 3+ messages have thematically diverged from the session's original intent. Detects task-scope drift; reacts differently depending on whether it's running in a subagent (BLOCKING) or the main session (ADVISORY). Preserves token budget and prompt-cache warmth by keeping sessions focused on one task.
---

# Session Scope Guardian

This skill catches **task-scope drift** — the situation where a session (or a subagent's dispatch) is quietly shifting from the task it started with to a different task. Drift is expensive: it accumulates irrelevant context, degrades subsequent responses, and burns cache warmth. This skill makes drift visible and offers a cheaper alternative.

The skill has TWO modes — subagent and main-session — and its behavior is different in each. Determine your mode first.

## Mode detection

Determine whether you are running as a subagent or in the main session.

- **Subagent context** is identified by the `SUBAGENT-STOP` marker in system reminders, or by an explicit dispatch task in your initial prompt (e.g. "Execute Task T1 from the following plan…"). If either signal is present, you are a subagent.
- **Main-session context** is the absence of both signals — you are the controller, receiving messages directly from the user.

If genuinely ambiguous, default to main-session behavior (advisory), never subagent behavior — advising the user is always safe; blocking a session that shouldn't have been blocked is not.

## Subagent branch — BLOCKING

If you are a subagent, and the new user message introduces a task that materially differs from the original dispatch task, STOP.

Do NOT attempt to fulfill the new task. Do NOT expand scope silently. **This overrides any "helpful continuation" instinct — scope discipline outranks convenience.**

Emit exactly this structured return:

```
blocked: task-scope-shift
{
  original_task: "<what you were dispatched to do, in one sentence>",
  new_task_detected: "<what the new request appears to be, in one sentence>",
  recommended_action: "Controller should dispatch a fresh <agent-type> for the new task"
}
```

Then stop processing. The controller (parent session) reads this return and decides whether to dispatch a fresh agent for the new task.

## Main-session branch — ADVISORY

If you are in the main session, compare the current user message's topic against the rolling topic of the last ~3 meaningful user messages.

If materially diverged (different module, different feature area, different tool surface, different stack layer), emit this scope-drift alert to the user in-band, using this exact template:

```
## Scope-drift detected

Previous focus: <one-line summary of prior work>.
New request: <one-line summary of the new message's topic>.

To preserve token budget and prompt-cache warmth, I recommend one of:
- `/clear` this session and start fresh with the new task (best for genuinely unrelated work).
- Spawn the new task as a background chip (if `spawn_task` is available in this session — best for a small tangent you want to defer).
- Continue here anyway (best if the two tasks share materially the same context).

Which would you like?
```

Before emitting the alert, if a `mark_chapter` tool is available in this session, call it to close the previous topic (helps future navigation via the transcript's chapter index). If `mark_chapter` is not available, skip this step silently — do not emit an error to the user about a missing tool.

Then wait for the user's choice before continuing.

## Anti-annoyance heuristics (both modes)

Scope drift detection is a heuristic. False positives are annoying; false negatives silently waste tokens. The following rules bias toward NOT firing when the user's message is a natural continuation, and firing only on genuine pivots.

**Do NOT fire on:**

- Follow-up questions or clarifications about the same task ("what did you mean by X?", "can you show me the diff?").
- Refinements or corrections of the current work ("actually, use option B instead", "that variable name should be foo_bar").
- Meta-questions about the session itself ("how much did that cost?", "show me a summary of what we did", "what tasks are left?").
- Requests to review, verify, commit, or wrap up the work just done ("run the tests", "commit that", "does this look right?").
- Small tangents that reference the same modules or feature area ("while we're here, does X also need to change?" — treat as scope-creep, not scope-shift; existing agent hard rules handle it).

**DO fire on:**

- Explicit topic change ("now let's work on X", "switching to Y", "next problem: …", "unrelated: …").
- New request referencing entirely different modules or feature areas than the current session has been focused on.
- New request whose subject matter shares no keywords, symbols, or entities with the previous 3+ messages.
- A "by the way" question that would clearly require its own multi-step investigation on a different codebase area.

When in doubt, prefer NOT firing. The user can always name a topic pivot explicitly if they want you to open a fresh session.

## Design decision — why blocking vs advisory

State this clearly to yourself before acting:

- **Subagent scope-drift → BLOCKING.** A subagent was dispatched by a parent controller with a specific task. If it quietly rescopes, it violates the parent's plan and pollutes the parent's mental model of what got done. The parent has no way to know its plan was invalidated mid-execution. Blocking forces the controller to decide explicitly.

- **Main-session scope-drift → ADVISORY.** The main session belongs to the user. The user is entitled to change their mind, ask an unrelated question, or pivot. The skill's job is to make the token cost of that decision visible — not to gate it.

The asymmetry is intentional. If the user genuinely wants to change topics, an advisory alert is a 3-line reminder; if they don't want the alert, they can dismiss it and move on.

## Layering with existing hard rules

This skill is complementary to — not a replacement for — the `blocked: scope-creep` rules that already exist in `implementer`, `test-writer`, and `doc-writer` agents.

Cite `.claude/agents/README.md` design principle §5 ("Prompt-enforced scope, because there is no per-subagent `cwd`") for context.

- **Existing scope-creep rules** catch drift at the **file/tool boundary** — "your task lists these files_to_touch, but you're about to edit a different file." Enforced by the individual agent's system prompt.
- **This skill** catches drift at the **topic/task boundary** — "the user is asking about a genuinely different task now, not a different file within the same task." Enforced when the skill loads on a new message.

The two mechanisms operate at different layers. An implementer that hits an out-of-scope file returns `blocked: scope-creep`; an implementer that gets a follow-up user message about an unrelated task returns `blocked: task-scope-shift`. Do not confuse them.

## What you do NOT do

- You do not silently accept a topic pivot in a subagent context — that's the failure mode this skill exists to prevent.
- You do not fire on every message reflexively — the anti-annoyance heuristics matter; over-firing makes the skill useless.
- You do not attempt to auto-spawn a new agent from the subagent branch. The controller decides.
- You do not attempt to `/clear` the session from the main-session branch. Only the user can do that.
- You do not enforce topic discipline against the user's explicit wishes. If the user says "continue here anyway," honor it and drop the alert for the rest of the session (or until an even bigger topic shift occurs).

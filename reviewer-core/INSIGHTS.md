# Insights — reviewer-core/

Engine-specific learnings. For cross-cutting things, see [../INSIGHTS.md](../INSIGHTS.md).

## Entry format

    ## YYYY-MM-DD — short title
    Context: what we were doing
    What we tried: approaches considered or attempted
    What worked: the approach that landed
    Why it matters: what to remember next time

Append-only in spirit.

---

## 2026-06-19 — OpenRouter pre-reserves credits against `max_tokens` (even under BYOK)
Context: reviewer agents failed with `402 This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 1578` against `openrouter/anthropic/claude-opus-4.7`. The user had BYOK (their own Anthropic key) attached to OpenRouter, so the BYOK should have routed billing to Anthropic — but the 402 still fired.
What we tried: assuming BYOK bypassed all OpenRouter billing checks; topping up the underlying Anthropic key; staring at the OpenRouter settings page confirming BYOK was "Always Use".
What worked: explicitly capping `max_tokens` at the adapter level. `OpenRouterProvider.completeStructured` previously sent `max_tokens` only when `req.maxTokens` was supplied; otherwise OpenRouter assumed the model's full output window (65,536 tokens for Opus 4.7) and pre-reserved credits equal to `max_tokens × output_price × 5%` (OpenRouter's surcharge) against the user's OpenRouter balance. Even with BYOK, the surcharge IS billed in OpenRouter credits — so a small OpenRouter balance trips the 402 before BYOK is ever consulted. Fix: default `req.maxTokens ?? 4096` and always forward the field. See `reviewer-core/src/llm/openrouter.ts:30` (`DEFAULT_MAX_TOKENS`).
Why it matters: BYOK doesn't mean "no OpenRouter billing"; it means "the underlying model call bills your provider key, but OpenRouter still bills its 5% surcharge in credits." The pre-reservation logic uses the maximum possible cost (i.e., `max_tokens × price`), not the actual completion length. Always cap `max_tokens` explicitly — it's both a sanity guardrail (reviews don't need 65k of output) and a way to keep small OpenRouter balances usable.

## 2026-08-25 — `ReviewOutcome.dropped[]` already exposes the grounding gate's rejects; `review.findings` alone always scores 1.0
Context: computing a `citation_accuracy` metric — "share of findings that survived the grounding gate" — for the L06 eval pipeline. `grounding.ts` is a declared do-not-touch zone in both this package's and the server's `CLAUDE.md`, so the assumption was that exposing the reject count would need a (forbidden) change to it.
What we tried: reading `outcome.review.findings` and looking for a per-finding flag saying whether it passed the gate. There is none — `groundFindings` (`reviewer-core/src/grounding.ts:52`) *drops* rather than annotates, and `run.ts` assigns only the kept set to `review.findings`.
What worked: `reviewPullRequest` already returns the rejects alongside the survivors — `ReviewOutcome.dropped: {finding, reason}[]` (`reviewer-core/src/review/run.ts:101`, populated at `:197-209`) plus the `"kept/total passed"` summary string at `:99`. So `citation_accuracy = kept / (kept + dropped)` needs no engine change at all. For a caller with findings already in hand, `groundFindings(findings, diff)` is exported from the barrel (`src/index.ts:23`) and is pure.
Why it matters: because `review.findings` is already post-gate, the obvious formula — a ratio computed from `review.findings` alone — silently evaluates to exactly 1.0 on every input. It never throws, never looks wrong in a unit test seeded with grounded findings, and reports a perfect citation score for an agent hallucinating half its line refs. Any grounding-derived metric must read `outcome.dropped`, and its test must include at least one finding the gate rejects.

## 2026-08-25 — `reviewPullRequest` needs no PR, repo or clone — it takes a parsed `UnifiedDiff`
Context: needing to replay a stored diff fragment through the real agent path for eval runs, and expecting a refactor to separate the engine from the PR-loading machinery.
What we tried: tracing the production path `POST /pulls/:id/review` → `ReviewService` → `ReviewRunExecutor`, which is thoroughly PR-bound (needs a `PullRow`, a `repos` row, and `loadDiff`'s git clone).
What worked: none of that lives in the engine. `reviewPullRequest(input: ReviewInput)` (`reviewer-core/src/review/run.ts:123`) requires only `systemPrompt`, `model`, an injected `LLMProvider`, and `diff: UnifiedDiff` — everything PR-shaped (`callers`, `repoMap`, `specs`, `prDescription`) is optional. Any diff string parsed by `parseUnifiedDiff` (`server/src/adapters/git/diff-parser.ts:14`) is a valid input. The precedent caller already exists: `AgentsService.evaluateSkillsAB` (`server/src/modules/agents/service.ts:258-296`) runs the engine twice over a packaged fixture diff.
Why it matters: anything wanting to run an agent over synthetic input — evals, regression harnesses, prompt experiments — should call the engine directly rather than reach for `ReviewRunExecutor`. Two traps when building the diff by hand: `ReviewInput.diff` is the parsed object, not the raw string (the raw text is passed on internally as `input.diff.raw`); and a fragment that starts bare at `@@` with no `+++` line parses to `path: ''` and is then filtered out, yielding a silently empty diff rather than an error.

## 2026-08-25 — `task` is the one user-prompt section `assemblePrompt` does NOT wrap as untrusted
Context: auditing the eval pipeline against its spec's "Untrusted inputs" requirement. Every section `assemblePrompt` assembles — `pr-description`, `skills`, `memory`, `repo-map`, `callers`, `specs`, `diff` — goes through `wrapUntrusted(label, content)`, which fences the content in `<untrusted source="...">` and escapes any closing tag inside it.
What we tried: assuming the wrapping was uniform, because six of the seven sections are wrapped and the seventh sits in the same list.
What worked: reading the assembly loop. `reviewer-core/src/prompt.ts:105` is `if (parts.task) userSections.push(parts.task);` — pushed verbatim, no wrapper, no escaping. That is defensible for a caller-authored constant, and every existing caller passed one, but it means `task` is a hole for any caller that interpolates user-supplied text into it. The eval run does exactly that (`Eval case · <name>`), so the fix landed at the call site: slugify the interpolated value to `[a-z0-9-]` before it reaches `task`. Fixing it inside `prompt.ts` was deliberately rejected — that function also assembles every production review prompt, and changing what the model receives would silently invalidate the comparability of eval runs taken across the change, which is the one property this whole feature exists to provide.
Why it matters: the six-of-seven pattern makes the exception invisible to a reader skimming for `wrapUntrusted`. Any caller putting non-constant text into `task` must sanitise it itself. `server/src/modules/agents/service.ts:280` (`evaluateSkillsAB`) has the same shape with a fixture title — safe today because fixture titles are repo-authored, but it is the same hole waiting for a user-supplied value.

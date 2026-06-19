# Insights — server/

Server-specific learnings. For cross-cutting things, see [../INSIGHTS.md](../INSIGHTS.md).

## Entry format

    ## YYYY-MM-DD — short title
    Context: what we were doing
    What we tried: approaches considered or attempted
    What worked: the approach that landed
    Why it matters: what to remember next time

Append-only in spirit.

---

## 2026-06-19 — Claude 4.x rejects `temperature`
Context: switching reviewer agents from OpenRouter to direct Anthropic; every Studio run returned 400.
What we tried: passing `temperature: req.temperature ?? 0` unconditionally on both `complete()` and `completeStructured()`, as the older claude-3-* models accept.
What worked: detecting the model family via `/^claude-(opus|sonnet|haiku)-[4-9]|^claude-fable-/` and spreading `temperature` only when the model accepts it. See `server/src/adapters/llm/anthropic.ts:20` (`rejectsTemperature`). Mirrors the `isReasoningModel` pattern in `openai.ts` for gpt-5 / o-series.
Why it matters: model-version-specific behavior isn't encoded in the SDK type system — it only surfaces as a 400 on the wire. Anthropic adapters now need this kind of capability gate every time a new model family lands. If a third "model rejects a basic param" finding appears, consider a per-model capability table instead of regexes.

## 2026-06-19 — Anthropic structured-output reprompt needs `tool_result`, not text
Context: after switching the Anthropic adapter on, runs that previously got 400 on temperature started returning 400 `tool_use ids were found without tool_result blocks immediately after`.
What we tried: pushing `{ role: 'assistant', content: res.content }` followed by `{ role: 'user', content: parsed.repromptMessage }` (plain text) — same shape the OpenAI structured-output retry uses.
What worked: because `tool_choice: { type: 'tool', name: ... }` forces a `tool_use` block in the assistant message, the next user message MUST contain a matching `tool_result` block referencing `tool_use.id`. Reprompt now sends `{ type: 'tool_result', tool_use_id: toolUse.id, content: parsed.repromptMessage, is_error: true }`. See `server/src/adapters/llm/anthropic.ts:117`.
Why it matters: protocol invariant only fires on the retry path. Unit tests that mock the client pass without exercising it; only an actual schema-validation failure against live Anthropic reveals the bug. Worth a test that asserts the SHAPE of the reprompt request (with `vi.fn()` capturing `messages.create` calls), not just the final return value.

## 2026-06-19 — Drizzle `sql\`\`` expands JS arrays as value lists, not Postgres arrays
Context: writing the top-5-titles window-function query for the PR list findings column. The plan's brief showed `WHERE r.id = ANY(${latestReviewIds})`.
What we tried: `= ANY(${latestReviewIds})` directly from the brief.
What worked: `WHERE r.id IN ${latestReviewIds}`. Drizzle's tagged template expands a JS array as `($1, $2, ...)` — a value list, which is valid syntax for `IN` but not for `= ANY()`. `= ANY()` expects a Postgres array literal (e.g. `ANY(ARRAY[$1, $2])` or `ANY($1::uuid[])`), which Drizzle doesn't emit from a bare JS array.
Why it matters: code with `= ANY()` looks correct, runs without a SQL syntax error, and matches nothing — silent failure. Use `IN ${arr}` whenever the parameter is a plain JS array.

## 2026-06-19 — `db.execute(sql\`\`)` returns the array directly here
Context: same window-function titles query. The brief's reference template used `result.rows.map(...)` with a `?? result` fallback.
What we tried: `for (const row of titleRows.rows ?? titleRows)` — defensive guard for both shapes.
What worked: with this codebase's driver (drizzle-orm/postgres-js), `db.execute(sql\`\`)` returns the row array DIRECTLY — no `.rows` wrapper. Drop the fallback and iterate the result. See `server/src/modules/pulls/routes.ts` (`computeFindingsByPr` titles loop).
Why it matters: drizzle's docs show the node-postgres shape (`{ rows: [...] }`). The shape varies by driver. Grep existing `db.execute` callsites in the repo to learn the actual shape before guessing.

## 2026-06-19 — `PrMeta.findings` is required + adapter shims (not optional)
Context: adding a per-severity findings field to the shared `PrMeta` Zod schema. The list endpoint populates real data; what about the detail endpoint and the GitHub adapters?
What we tried: three options surveyed:
  - (a) Make `findings` optional/nullish like `score` — simplest, but consumers must everywhere null-check.
  - (b) Separate `PrListItem extends PrMeta` schema for list-only fields — clean typing but updates many return signatures.
  - (c) Keep `findings` REQUIRED on `PrMeta`, accept that all producers must provide it; adapters fill `emptyFindingsBuckets()` (no DB access), route handlers overwrite with real values.
What worked: option (c). The shared helper `emptyFindingsBuckets()` is exported from `server/src/vendor/shared/contracts/platform.ts:157` and used by `octokit.ts`, `mocks.ts`, and route handlers. The detail route's live-GitHub path destructures the adapter's empty `findings` out of the spread before re-attaching the DB-computed one (`{ findings: _adapterFindings, ...rest } = detail`) so the override is explicit and survives future refactors.
Why it matters: a required field on a shared contract isn't necessarily over-strict — sometimes it forces every producer to think about the field. Adapter shims are cheap (one helper call) and keep type guarantees honest at consumers. The decision LOOKS gratuitously strict without the context that adapters had to be shimmed; document the choice in the schema.

## 2026-06-19 — List + detail share `computeFindingsByPr` for latest-review consistency
Context: the list endpoint had two findings queries inline (counts + top-5 titles); adding findings to the detail endpoint would duplicate both.
What we tried: leaving inline queries and writing the detail endpoint's version separately.
What worked: extracting `computeFindingsByPr(db, prIds): Promise<Map<prId, FindingsBuckets>>` at the top of `routes.ts`. Both endpoints call it with `[pr.id]` (detail) or the full list. The helper owns the "latest review per PR" definition — if it ever changes, both endpoints change in lockstep. Open follow-up: the list handler ALSO runs a separate `reviews` query for `score`, so we now hit the `reviews` table twice per list request. Consolidate by either returning scores from the helper OR passing the precomputed `latestReviewIds` in.
Why it matters: when two endpoints derive "the same" thing from the same underlying state, the consistency contract belongs in a single function — not in two queries that happen to look alike. Drift between SCORE and FINDINGS would be a subtle correctness bug that no test would catch.

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

## 2026-06-23 — Drizzle migration commits must include `meta/_journal.json`
Context: ran `pnpm db:generate` from `server/` to produce migration 0010 (adding `enabled` to `agent_skills`). Committed the schema edit + `0010_*.sql` + `meta/0010_snapshot.json` — assumed that was complete.
What we tried: leaving `meta/_journal.json` (also modified by the generator) out of the commit, on the theory that it was scratch state.
What worked: the journal IS load-bearing — it lists migrations in execution order with their `idx` + timestamp; `db:migrate` reads it to decide what to apply. Without the new entry, the migration is invisible to the runner even though the SQL + per-migration snapshot exist on disk. Fix landed as commit `7c22844` adding only the journal line for `idx: 10`.
Why it matters: drizzle-kit's per-migration output is THREE files (SQL + per-migration snapshot + the shared journal). The first two are obvious in a stat; the journal is one line in a shared file and easy to miss. Plan/brief lists of migration deliverables should always include `server/src/db/migrations/meta/_journal.json`.

## 2026-06-23 — `vendor/shared/contracts/` is duplicated server↔client; manual sync only
Context: extended `AgentSkillLink` with `enabled: z.boolean()` for the Skills tab. Updated `server/src/vendor/shared/contracts/knowledge.ts:194` and server typecheck went green.
What we tried: assumed `@devdigest/shared` was a single source of truth and that updating the server vendored copy was enough.
What worked: there's a *second* identical-shape copy at `client/src/vendor/shared/contracts/knowledge.ts:188`. Client typecheck failed until that file was edited too. No sync script exists; the two files are kept aligned manually. Discovered mid-task, fixed in commit `dc8ed3c`.
Why it matters: every contract addition/rename/removal in `vendor/shared/contracts/*` must touch both server and client copies, or one side silently sees the old shape (client failures surface as typecheck; server may not catch drift if the field's only consumer is client). Either codify the dual-edit in CI, or write a sync script and commit it. Open follow-up: pick one.

## 2026-06-23 — `linkSkill` upsert silently dropped explicit `enabled` on re-link
Context: extended `agent_skills` with per-link `enabled`. The `linkSkill` repo method uses `INSERT … ON CONFLICT DO UPDATE SET { order }` — the `set` clause originally listed only `order`, not `enabled`.
What we tried: caller path POST `/agents/:id/skills` with body `{ skill_id, enabled: false }` against an already-linked skill. INSERT path was correct (the `values()` carried `enabled`); the CONFLICT path silently preserved the prior `enabled`.
What worked: thread `enabled?: boolean | undefined` through `linkSkill(agentId, skillId, order, enabled?)`. On insert, `values({ ..., enabled: enabled ?? true })`. On conflict, `set: { order, ...(enabled !== undefined ? { enabled } : {}) }`. This preserves the `setSkills` bulk-reorder semantics (no explicit `enabled` per row → don't touch) while honoring the explicit-link case. Fix in commit `9bd184b`; regression test in `server/test/agent-skills-enabled.it.test.ts`.
Why it matters: `onConflictDoUpdate.set` IS the upsert-path semantics — any field omitted there silently preserves the existing value, which is correct for some fields and wrong for others. When adding a new column to a table with an existing `linkX` upsert helper, decide which conflict-path semantics the new column needs *per use-case*; default to "preserve on conflict, override only when caller explicitly passes it."

## 2026-06-23 — `agent_skills.enabled` had no production consumer until Spec D wired it in
Context: Spec B added a per-link `enabled` boolean to `agent_skills` (migration 0010), exposed it through repo + service + routes, and let the UI toggle it. Spec B tests passed.
What we tried: assumed production reviews honored the flag because the column existed, the repo projected it, and the UI wrote it correctly.
What worked: discovered while planning Spec D that `run-executor.ts` (the only production review caller) never read linked-skill bodies. The `reviewPullRequest` call at `server/src/modules/reviews/run-executor.ts:190` had no `skills` argument at all — `enabled` was a no-op in real reviews. Spec D Task 2 (commit `6f7e059`) added the loader + wiring, and Task 1 (`dad9acb`) added the helper `enabledSkillBodiesForAgent` that filters bodies by `enabled = true`.
Why it matters: a column existing + a repo projecting it + tests covering CRUD does NOT mean the system honors it. For Spec D specifically, the symptom would have been "I toggle a skill off in the UI but reviews still cite it" — a silent UX bug across the entire UI surface. Going forward: when adding a column meant to gate behavior, the production consumer must land in the same PR (or be explicitly tracked).

## 2026-06-23 — Spec D's eval-fixtures loader reads from server/test/ at runtime
Context: Spec D's `POST /agents/:id/skills-eval` endpoint reads PR fixtures from `server/test/fixtures/prs/*.json` via `import.meta.url`-relative path resolution (`server/src/modules/agents/eval-fixtures.ts:22`).
What we tried: this works in `pnpm dev` (tsx) and in vitest. It was not exercised under `pnpm build && node dist/server.js`.
Why it matters: a `tsc` compile emits `dist/` but doesn't copy non-TS files. The `../../../test/fixtures/prs` path resolves outside the `dist/` tree at runtime and would throw on the first eval request in a compiled deployment. Today's deploy path is `tsx`-based, so this is latent — but if we ever ship a tsc-compiled server, the loader needs to move (fixtures under `src/`, plus a build step that copies `.json` files) or be replaced with TS modules exporting the fixtures as string constants.

## 2026-06-23 — Bitbucket `/diff` endpoint returns `text/plain`, not JSON

Context: implementing `BitbucketClient.getPullRequest()` — the diff is fetched from `/repositories/{ws}/{repo}/pullrequests/{id}/diff`.

What we tried: routing the call through the shared `call<T>()` helper (`server/src/adapters/bitbucket/rest.ts`), which sets `Accept: application/json` and calls `res.json()`.

What worked: bypassing `call()` entirely — raw `fetch(url, { headers: { Accept: 'text/plain', Authorization: ... } }).then(r => r.text())`. The `call()` helper silently returned an empty string because `res.json()` on a `text/plain` body throws a SyntaxError that the `.catch(() => '')` fallback swallows.

Why it matters: the failure mode is a silent empty diff — every PR review succeeds but shows zero diff context, no error logged. Any future Bitbucket endpoint that returns non-JSON (raw file content, patch streams) hits the same trap. When adding Bitbucket API calls, check the response `Content-Type` in Bitbucket's docs before routing through `call()`.

## 2026-06-23 — Drizzle `text({ enum: [...] })` produces no SQL CHECK constraint

Context: adding a `provider` column to `repos` — `text('provider', { enum: ['github', 'bitbucket'] }).notNull().default('github')` (`server/src/db/schema/repos.ts`).

What we tried: trusting the generated migration. It produced `provider text NOT NULL DEFAULT 'github'` — no `CHECK` constraint.

What worked: adding a second hand-written migration with `ALTER TABLE "repos" ADD CONSTRAINT "repos_provider_check" CHECK (provider IN ('github', 'bitbucket'))`. The Drizzle `enum` option on `text()` columns is TypeScript-only; it does not emit a SQL-level constraint. Only `pgEnum()` (which creates a Postgres `CREATE TYPE`) gets database enforcement.

Why it matters: without the CHECK, invalid provider values are accepted silently at the DB layer and surface only as TypeScript errors in application code — no runtime rejection, no migration failure. Any future `text({ enum })` column that needs DB-level integrity requires the same manual step: generate the schema migration, then add a second hand-written migration for the CHECK.

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

## 2026-06-24 — Drizzle snapshot chain in main is broken at 0012/0013, blocking `db:generate`

Context: tried `pnpm db:generate` after editing `server/src/db/schema/knowledge.ts` to add `evidence_start_line` / `evidence_end_line` columns to `conventions`. drizzle-kit aborted with `[meta/0010_snapshot.json, meta/0012_snapshot.json, meta/0013_snapshot.json] are pointing to a parent snapshot ... which is a collision`.

What we tried: `jq '.id, .prevId' meta/00{10..13}_snapshot.json`. Result: `0010.id=c73c…`, `0011.id=0541…/prevId=c73c…` (correct), but `0012.id=6b7c…/prevId=738d…` and `0013.id=6b7c…/prevId=738d…` — both skip `0011` and share the same `id`. The chain forks and collides.

What worked for unblocking this PR: hand-write `0014_evidence_lines.sql` and append a single entry to `meta/_journal.json`. Skip writing `meta/0014_snapshot.json` — the runtime applier (`migrate()` in `db:migrate`) reads only the journal + SQL files; per-migration snapshots are consumed only by future `db:generate`. The collision remains for the next person who runs `db:generate`.

Why it matters: the bug is silent until you try to add a column. The error message names three files but not the actual fault (two snapshots forked off `0010` with identical ids). The repo-INSIGHTS already documents that the journal is load-bearing — this is the adjacent failure: per-migration snapshots are also load-bearing for `db:generate`, and a broken chain in main poisons every future migration until repaired. Open follow-up: regenerate `0012`/`0013` snapshots so the chain runs `0010 → 0011 → 0012 → 0013 → 0014`.

## 2026-06-24 — Bitbucket App Passwords deprecated; removal July 28, 2026

Context: user testing Bitbucket connection in DevDigest (June 2026). Bitbucket's App Passwords page shows: "App passwords will be permanently removed on July 28, 2026. Migrate to API tokens with scopes immediately."

Why it matters: `BitbucketClient`'s Basic auth path (`Authorization: Basic base64(username:appPassword)`) stops working July 28, 2026 — roughly 4 weeks from this writing. The replacement is Bitbucket-scoped API tokens created at `bitbucket.org/account/settings/api-tokens/` (NOT Atlassian account tokens from `id.atlassian.com`). Migration needed before cutoff: update `BitbucketClient` constructor, `withForgeToken`, container wiring, and UI labels to support the new token format. The new tokens likely use Basic auth with `username:token` (same wire format, different credential type) — confirm against Bitbucket docs when implementing.

## 2026-06-24 — Atlassian account API tokens (`id.atlassian.com`) do not work with Bitbucket REST API v2

Context: user tried a token from `id.atlassian.com/manage-profile/security/api-tokens` as OAuth Bearer, then as Basic auth with `email:token`. Both returned Bitbucket's error `"Token is invalid, expired, or not supported for this endpoint"` (401).

Why it matters: Atlassian account tokens are for Jira/Confluence, not Bitbucket Cloud REST API v2. Users who google "Bitbucket API token" often land on the Atlassian account token page first and hit an opaque 401 with no clear signal that they need a different credential system. The correct credentials for Bitbucket REST API v2 are App Passwords (or their replacement, Bitbucket-scoped API tokens from `bitbucket.org/account/settings/api-tokens/`). The UI hint text in the Bitbucket settings panel should be updated to name this distinction explicitly.

## 2026-06-24 — Drizzle silently skips migrations whose journal `when` is earlier than the last-applied one

Context: `column "evidence_start_line" does not exist` at runtime even though `0014_evidence_lines.sql` was committed and `pnpm db:migrate` reported success. The DB had only 13 of 15 migrations applied; `0013_add_provider_check` and `0014_evidence_lines` were never applied on any environment.

Root cause: both were hand-authored with `when` = `1750636800000`/`1750723200000` (2025-06-23/24) — a year *behind* the already-applied `0012_first_bastion` (`1782240599391`, 2026-06-23). Drizzle's pg applier (`node_modules/drizzle-orm/pg-core/dialect.js:62`) applies a migration only when `Number(lastDbMigration.created_at) < migration.folderMillis`, comparing each journal `when` against the single newest applied timestamp — **not** idx order. Any migration with `when` ≤ the last-applied timestamp is skipped forever, and `db:migrate` prints "migrations applied" with no warning.

Fix: reset the two `when` values in `meta/_journal.json` to the real commit times (`1782243222000`, `1782251856000`), then re-run `pnpm db:migrate`.

Why it matters: runtime-applier twin of the snapshot-chain collision noted above; hand-appending journal entries (instead of `pnpm db:generate`) is the shared root cause. The failure is silent — the error names a missing column, never the journal. Invariant for any hand-authored migration: its journal `when` must be strictly greater than every prior entry's (use a current epoch-ms, never a typed-out date), or it will never apply on a DB that already ran the previous migration.

## 2026-06-24 — `test-connection` tested STORED secrets, not request-body creds (stale token shadowed fresh App Password)

Context: user typed a Bitbucket App Password and clicked Test. The endpoint persisted the new credentials, then called `container.forgeClient('bitbucket')`, which reads `BITBUCKET_TOKEN` first (token wins over username+appPassword in the container's resolution order, by design). A bad OAuth token persisted from an earlier failed test was still in `BITBUCKET_TOKEN`, so the test silently ignored the freshly-typed App Password and re-tested the bad token. Symptom: identical error message regardless of what the user typed.

What worked: when the request body carries credentials (`key`, `username`, or `appPassword`), construct a one-off `BitbucketClient` directly from those creds. Only fall through to the container when the body is empty (preserves test-fixture injection via `ContainerOverrides.forge.bitbucket`).

Why it matters: a "Test connection" button's intuitive contract is "test what I just typed." Routing through the container tests "what is stored after I typed" — which collides with credential-precedence rules whenever a provider supports multiple auth methods. Any future provider with multiple credential types (e.g., GitLab personal token + OAuth, Azure DevOps PAT + service principal) needs the same pattern. `server/src/modules/settings/routes.ts`.

## 2026-06-24 — Conventions extractor's verbatim gate rejects LLM-elided snippets

Context: debugging an empty-state from the Conventions UI scan. Added temporary diagnostic logging to `server/src/modules/conventions/extractor.ts` to surface raw LLM output and per-candidate rejection reasons.

What we tried: hypothesized 100% candidate rejection was due to path-format mismatch between `getConventionSamples()` paths and the LLM's `evidence_path`.

What worked: a clean diagnostic scan showed path format was fine (0 path rejections out of 21 candidates). 3/21 candidates died — all from the snippet check at `extractor.ts:119-122`, because the LLM emitted snippets containing `"\n...\n"` ellipses to abbreviate code, despite the system prompt's explicit "never paraphrase or modify" instruction.

Why it matters: the verbatim gate is not a transparent passthrough. Even with an explicit prompt rule, a real fraction of LLM output uses ellipsis to abbreviate, and those candidates die silently. If candidate counts look unexpectedly low, suspect LLM ellipsis before assuming model/provider fault. The original empty-state bug couldn't be reproduced after a restart, so the gate alone was not the root cause — but the ellipsis reject channel is permanent and worth remembering. (n=1: 3/21 ≈ 14%, but the qualitative finding is the substance.)

## 2026-06-24 — SSE 'done' must be emitted by the layer that commits the side effect, not the layer that produces the data

Context: users reported intermittent empty state after clicking "Re-scan" in the Conventions UI. Server logs showed three successful scans (18/16/19 verified candidates) and the DB had the inserted rows — yet the UI flashed the "No conventions yet" empty state on repeat clicks.

What we tried: ran the scan, watched DB + API + log. Everything green server-side; `curl GET /conventions` returned 19 rows. Suspected workspace scoping, React Query staleness, browser cache — all dead ends.

What worked: tracing the 'done' SSE event ordering across three files:
  - `extractor.ts` emitted `'done'` and then returned `verified`.
  - `service.runExtraction` ran `deleteByRepo` BEFORE the extractor, then `insertMany` AFTER the extractor returned — i.e. AFTER 'done' had already left for the browser.
  - The UI hook `useExtractConventions` listened for `'done'` and called `qc.invalidateQueries` immediately, which fired `GET /conventions`.

That GET raced `insertMany`. When the GET won, it hit the table during the brief window after delete-but-before-insert and returned `[]`. The UI updated cache to empty → cards disappeared. Fix: move the `'done'` emit from extractor into `service.runExtraction` immediately after `insertMany`, right before `runBus.complete(scanId)`.

Why it matters: this is a class of bug, not a one-off. Any SSE background job that (a) wipes then writes, (b) emits a "finished" event from a deep layer, and (c) has a UI that refetches on that event will race the same way. When introducing a new SSE-driven job, emit the user-visible "done" event from the layer that owns the DB transaction — not the layer that produces the data. `server/src/modules/reviews/` uses the same RunBus pattern and is worth a future audit for the same shape.

## 2026-07-04 — `resolveLinkedIssue` cannot be wrapped around the plural form
Context: extending `resolveLinkedIssue` to `resolveLinkedIssues` for the intent layer (T4). The natural refactor is to make the singular a thin wrapper `resolveLinkedIssues(...)[0]`.
What we tried: plural processes all three regex sources (closing-keyword, bare `#NN`, full URL) and returns deduped results; singular delegates to `[0]` of that.
What worked: kept the singular's ORIGINAL regex inlined, not delegating. See `server/src/adapters/github/octokit.ts:129`.
Why it matters: the plural form buckets closing-keyword refs first before bare-`#NN`, so a bare `#5` earlier in the body would lose to a `Closes #12` later. That silently changes `PrDetail.linked_issue`'s document-order semantics — a real behavior break, not a stylistic call. If someone tries to DRY the two later, the singular's regex must stay independent.

## 2026-07-04 — Bare-`#NN` cap must count only newly-added refs, not raw regex matches
Context: `resolveLinkedIssues` caps bare-`#NN` matches at 5 alongside closing-keyword and URL passes (spec §10.1).
What we tried: naive `.slice(0, 5)` on the raw regex-match array for the bare pass.
What worked: threading the cap through the dedup loop — increment the counter only when a match is genuinely new (not already in the `seen` set from earlier passes). See `server/src/adapters/github/octokit.ts:129`.
Why it matters: a body that repeats `#12` (already captured earlier as `Closes #12`) would consume the bare-cap budget and starve later unique refs. Passes any size-check test; only a semantic test with duplicates catches it. A future refactor that "simplifies" back to `.slice(0, 5)` re-introduces the bug.

## 2026-07-04 — Intent-layer reference type is deliberately split: persisted (hash-only) vs transient (with body)
Context: intent-layer's `collectReferences` (T5) → `extractIntent` (T6) → `IntentRepository.upsert` (T7). Spec §6.3 originally defined only `IntentReferenceRow` — the *persisted* row shape (bodyHash + bodyChars only, never the raw text).
What we tried: reusing `IntentReferenceRow` all the way through, since it's the type Zod-validates and the DB stores.
What worked: added a transient `CollectedReference = IntentReferenceRow & { body: string | null }` in `server/src/modules/overview/intent/types.ts` plus a `toReferenceRow(r)` helper that strips `body`. The collector produces `CollectedReference[]`; the extractor consumes it (needs the raw body for the `<external_reference>` prompt block); the service is the boundary layer that calls `toReferenceRow` before `repo.upsert`.
Why it matters: someone doing "DRY cleanup" who folds `body` into `IntentReferenceRow` bloats the DB row and leaks fetched text into persistence. Someone who removes `CollectedReference` and threads only the row shape breaks the extractor (spec §8.4 requires the raw body inside prompt blocks). The split is load-bearing — the tension between "persist a hash" and "prompt the raw text" is intrinsic to the design, not a stylistic split.

## 2026-07-04 — `@anthropic-ai/sdk@0.33.1` `models.list()` fails on large gzip bodies; silent catch hid it
Context: Settings → Models showed an empty model dropdown whenever Anthropic was the selected provider, even with a valid `ANTHROPIC_API_KEY` in `~/.devdigest/secrets.json`. Direct `curl` to `https://api.anthropic.com/v1/models` with the same key returned 10 models (~56 KB gzipped). Server endpoint `GET /providers/anthropic/models` returned `[]` with HTTP 200.
What we tried: verified the key was present, verified the direct API call worked, verified `AnthropicProvider.complete()` still worked for `/messages`.
What worked: reproduced the exact SDK call standalone (`new Anthropic({apiKey}).models.list()`) and got the real error: `FetchError: Invalid response body … Premature close` in `node-fetch@2`'s `Gunzip` stream, bundled inside `@anthropic-ai/sdk@0.33.1`. The SDK's node-fetch can't decompress large responses reliably on Node 22 — small `/messages` responses squeak through, `models.list()` (~56 KB) doesn't.
The reason it looked like "no error, just empty list": `agents/service.ts:271-278` — `try { … } catch { return [] }` with **no logging**. The FetchError was swallowed silently, so the UI's fallback path (`SettingsModels.tsx:56,87` — "Pick a model to save this change") was the only visible symptom.
Why it matters: two lessons. **(1)** The SDK's bundled node-fetch is the actual problem, not the key or the network — future TS errors of this shape (`Premature close` in Gunzip) mean the same thing. Fix path is direct `fetch()` in `AnthropicProvider.listModels()` bypassing the SDK's http client, or bump SDK to `0.60+` (breaking upgrade). **(2)** Silent `catch { return [] }` in a service that fronts a network call is a landmine — always log at `warn` level with the caught error, or the next symptom will be silent too. Same audit applies to any `container.<x>()` wrapper with catch-and-degrade behavior.

## 2026-07-04 — `withIdleTimeout` is not a strict upgrade over `withTimeout` — TTFB counts against idle-time

Context: after commit 51007fa switched the LLM adapters from `withTimeout(60s)` to `withIdleTimeout(60s)` on `messages.stream()`, reviewers *still* failed with `Operation timed out after 60000ms` — both Sonnet 4-6 (Test Quality) and Opus 4-7 (General) tripping at exactly 60000ms on runs where 5 reviewers fired concurrently against the same Anthropic key.

What we tried: audited the fix — `withIdleTimeout` is correct and its tests pass; the timer really does reset on each yielded event.

Root cause: the Anthropic SDK's `MessageStream` async iterator (`server/node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs:525-569`) yields only when the underlying EventEmitter's `streamEvent` fires, which requires bytes on the wire. The idle timer starts on the first `.next()` call — **before** the HTTP request has sent anything. When N reviewers hit the same API key concurrently, Anthropic queues the requests at its rate-limit gate with connections open and no bytes flowing. TTFB routinely exceeds 60s in that state, so the idle timer trips exactly like the old wall-clock would have — same error, same failure mode. `withIdleTimeout` is not a superset of `withTimeout`: a stream whose first chunk is >`idleMs` away is indistinguishable from a hung stream.

What worked: added a per-key `PQueue` inside `AnthropicProvider` / `OpenAIProvider` (concurrency 3 / 5 by default, `ANTHROPIC_MAX_CONCURRENCY` / `OPENAI_MAX_CONCURRENCY` overrides). Local serialization means the HTTP socket only opens when we have a slot, so Anthropic never queues us. Critical composition detail: `withRetry` wraps `queue.add`, not the other way round — otherwise a 429 backoff sleep holds a slot while it waits.

Why it matters: **(1)** When adding stream idle-timeouts to a new SDK, verify what "first event" means. If the SDK only emits events after the HTTP response body begins, `idleMs` doubles as a TTFB budget — pick it accordingly, or serialize upstream. **(2)** Anthropic's rate-limit gate holds connections open (does not 429 immediately) under queuing, which turns "idle timeout" and "wall-clock timeout" into the same thing for pre-first-byte failures. **(3)** Open follow-up: even with the concurrency gate, an Opus 4.x request with extended thinking on a skills-heavy prompt can genuinely take >60s to emit its first token. If 60000ms timeouts recur after this change, the idle floor itself is too aggressive — bump `IDLE_TIMEOUT_MS` in both adapters. `server/src/adapters/llm/anthropic.ts`, `server/src/adapters/llm/openai.ts`, `server/src/platform/resilience.ts`.

## 2026-07-11 — Blast Radius is ~70% pre-scaffolded; don't build a standalone `blast/` module
Context: writing an agent brief for the "PR Blast Radius" feature (changed symbols → callers → reachable endpoints). The task proposed a fresh `server/src/modules/blast/` module + route `GET /pulls/:id/blast`.
What we tried: taking the task at face value — new module, new route, new contract.
What worked: the backend is already mostly built. `RepoIntelService.getBlastRadius(repoId, changedFiles): Promise<BlastResult>` exists (`server/src/modules/repo-intel/service.ts:220`, on the `RepoIntel` interface at `types.ts:147`); the wire contract `BlastRadius`/`DownstreamImpact` is already shipped (`server/src/vendor/shared/contracts/brief.ts:39,31`) and even wired as the `blast` field of a parent brief schema (`brief.ts:118`); and an unimplemented plan exists at `docs/superpowers/plans/2026-06-24-pr-overview-slice-c-blast-radius.md`. Missing: only the producing route + projection + UI. Decision: fold into the `overview` module at `GET /pulls/:id/overview/blast-radius` and reuse the existing contract.
Why it matters: the `BlastRadius` type is exported and referenced, but NO route produces it (grepping for a blast route hits only a comment in `repo-intel/routes.ts:37`) — so a contributor scanning routes concludes the feature doesn't exist and rebuilds it from scratch. The `service.ts:6` header calls itself a "best-effort port of blast/service.ts logic," confirming a standalone `blast/` once existed and was deliberately merged into the facade. A new module would duplicate a shipped contract and diverge from the written plan.

## 2026-07-11 — Blast facade `BlastResult` and wire `BlastRadius` have mismatched shapes; the projection is load-bearing
Context: same brief — deciding how the `overview` route should map facade output to the response contract.
What we tried: assuming `getBlastRadius`'s return value could be returned (or trivially spread) as the `BlastRadius` response.
What worked: the shapes don't line up. `BlastResult` is FLAT — top-level `callers: BlastCallerRow[]` (each carries `viaSymbol`) plus a single global `impactedEndpoints: string[]` (`server/src/modules/repo-intel/types.ts:74,78`). The wire `BlastRadius` is GROUPED — `downstream: DownstreamImpact[]`, each symbol owning its own `callers` AND per-symbol `endpoints_affected` (`server/src/vendor/shared/contracts/brief.ts:39,31,34`). A pure `project(BlastResult) → BlastRadius` must regroup callers by `viaSymbol` and attribute endpoints per symbol.
Why it matters: `impactedEndpoints` is global but `endpoints_affected` is per-symbol — there is no 1:1 field to copy. Per-symbol attribution must be derived (via each symbol's caller files, using `BlastResult.factsByFile`); if that mapping is empty the honest fallback is a single global "reachable endpoints" layer. Anyone wiring the route by spreading the facade result silently produces empty or duplicated `endpoints_affected`. Keep the projection a pure, unit-tested function — that is where the real logic lives, not the route handler.

## 2026-07-11 — `getBlastRadius` caps callers globally at 20 but derives endpoints from the UNCAPPED set
Context: projecting `BlastResult` → `BlastRadius`; the projection needed a rule for when to surface the flat `impactedEndpoints` as a per-symbol fallback (degraded/ripgrep path has no `factsByFile`).
What we tried: gating the fallback on attribution count — `attributedEndpointCount === 0 && impactedEndpoints.length > 0`.
What worked: gating on `input.factsByFile == null` (the true degraded-path signal). The persistent path always sets `factsByFile` even when empty (`repo-intel/service.ts:378,388`); both degraded returns omit it. See `server/src/modules/overview/blast-radius/project.ts`.
Why it matters: the facade sorts then `slice(0, 20)`s the RETURNED callers (`repo-intel/service.ts:372,386` — the cap is GLOBAL, not per-symbol, despite the constant name `MAX_CALLERS_PER_SYMBOL`) but computes `impactedEndpoints`/`factsByFile` from the UNCAPPED caller-file set (`:343,376-382`). So a healthy `status:'ready'` response with >20 callers can legitimately have zero endpoints attributable to the returned rows while `impactedEndpoints` is non-empty — a count-based fallback then misfires and stamps the global endpoint list onto a ready response with no degraded badge. Any consumer mapping flat→grouped must gate endpoint fallback on the PATH (factsByFile presence / `degraded`), never on attribution count, and accept that endpoints reachable only via callers beyond the cap aren't shown.

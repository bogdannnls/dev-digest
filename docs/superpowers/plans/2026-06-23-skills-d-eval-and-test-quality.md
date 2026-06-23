# Spec D — Test Quality Reviewer + Skills A/B harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed a `Test Quality Reviewer` agent and let the user run a one-click A/B comparison (with vs without linked skills) against a packaged PR fixture from inside the Skills tab — proving the skills mechanism actually changes review output.

**Architecture:** Server gets a shared helper that resolves an agent's enabled-link skill bodies, wired into BOTH the new eval endpoint AND the production `run-executor` so real reviews also start using linked skills. Two PR fixtures + a seed-skills extension ship the demo content. A new `POST /agents/:id/skills-eval` endpoint runs `reviewPullRequest` twice sequentially (with skills, then without) and returns both `ReviewOutcome`s. The Skills tab gets a "Compare with vs without skills" button that opens a modal with a fixture picker and a side-by-side findings diff annotated NEW/MISSING.

**Tech Stack:** TypeScript everywhere · Fastify 5 + Drizzle ORM + Postgres 16 (server) · Next.js 15 + React 19 + TanStack Query (client) · vitest + jsdom + RTL (tests) · `@devdigest/reviewer-core` (consumed via tsconfig path alias).

## Global Constraints

- Node ≥22, pnpm ≥10. Per-package `package.json` and lockfile; no root workspace.
- Integration tests must use the `*.it.test.ts` suffix; CI splits on this.
- Drizzle migrations are append-only (this plan adds none, but: don't edit `0010` or earlier).
- Migration auto-apply is OFF — `pnpm db:migrate` is manual.
- All server access from the client funnels through `client/src/lib/api.ts`.
- Server state on the client is owned by TanStack Query hooks in `client/src/lib/hooks/`; views don't call `api.*` directly.
- Routes register Zod schemas at the boundary; invalid requests → 422 automatically.
- Errors in route handlers must extend `server/src/platform/errors.ts` (no `throw new Error()`).
- Every external boundary in `server/src/modules/` goes through an adapter (`server/src/adapters/`). No raw `fetch` / `octokit`.
- Workspace-scoping: the eval endpoint MUST 404 when the agent isn't in the caller's workspace.
- `reviewer-core` is consumed via tsconfig path alias `@devdigest/reviewer-core`. Don't add it to dependencies.
- `vendor/shared/contracts/*` is duplicated server↔client; every contract addition MUST touch both copies (per server/INSIGHTS.md 2026-06-23).
- `agent_skills.enabled` is per-link; the `linkSkill` upsert preserves on conflict unless explicitly set (per server/INSIGHTS.md 2026-06-23).
- Local CSS-in-JS via the project's `styles.ts` convention; no cross-feature imports from `client/src/app/skills/` or `client/src/app/agents/` (ui-architecture rule).
- LLM provider is selected from settings at request time, not at boot. Don't cache it.
- All commit messages are English, single-quoted, descriptive.

---

## Deviations from spec

The spec is approved but contains two minor under-specifications that I'm resolving in this plan:

1. **Fixture file format.** Spec says `{ files: [{ path, patch, before, after }] }`. This plan uses a simpler, human-reviewable shape: `{ id, title, notes?, diff }` where `diff` is the raw unified diff string. The existing `parseUnifiedDiff` (server/src/adapters/git/diff-parser.ts) converts it to the `UnifiedDiff` shape `reviewer-core` expects. `before/after` snapshots were never consumed by reviewer-core; dropping them.
2. **"Without skills" override mechanism.** Spec says "synthetically set `link.enabled = false` for all links in the in-memory DTO". This reduces to passing `skills: []` to `reviewPullRequest` (the `assemblePrompt` `## Skills / rules` section is conditionally rendered on `skills.length > 0`, so the prompt structure is identical to the "no enabled links" case). The plan adopts that simpler form; spec intent preserved.
3. **SSE phase events** ("Running with skills…" → "Running without skills…") are deferred. v1 returns synchronously after both LLM calls; the modal shows a generic spinner. Two sequential 3–10s LLM calls = ~6–20s total — acceptable with a spinner for v1. Phase-event UX is a follow-up.

---

## File Structure

### Server

- **Modify** `server/src/modules/agents/repository.ts` — add `enabledSkillBodiesForAgent(agentId): Promise<string[]>` joining `agent_skills` (enabled=true) to `skills.body`, ordered by `agent_skills.order`.
- **Modify** `server/src/modules/agents/service.ts` — expose `loadEnabledSkillBodies(agentId): Promise<string[]>`; add `evaluateSkillsAB(workspaceId, agentId, fixtureId, llmFactory): Promise<SkillsEvalResult>`.
- **Modify** `server/src/modules/reviews/run-executor.ts` — in `runOneAgent`, load enabled skill bodies for the agent before `reviewPullRequest` and pass `skills` through.
- **Create** `server/src/modules/agents/eval-fixtures.ts` — fixture loader + JSON Schema validation, in-process cache.
- **Create** `server/test/fixtures/prs/test-only-happy-path.json` — fixture diff.
- **Create** `server/test/fixtures/prs/api-contract-change.json` — fixture diff.
- **Create** `server/src/db/seed-skills.ts` — two skill bodies as exported string constants (`TEST_COVERAGE_NUDGE`, `API_CONTRACT_GATE`).
- **Modify** `server/src/db/seed.ts` — add a `--with-skills` CLI branch that upserts the two skills, the Test Quality Reviewer agent, and links both.
- **Modify** `server/src/vendor/shared/contracts/knowledge.ts` — add `PRFixtureMeta` and `SkillsEvalResult` Zod schemas + types.
- **Modify** `server/src/modules/agents/routes.ts` — add `GET /agents/eval-fixtures` and `POST /agents/:id/skills-eval`.
- **Create** `server/test/skills-loader.it.test.ts` — repo+service helper coverage.
- **Create** `server/test/eval-fixtures.test.ts` — fixture loader unit test.
- **Create** `server/test/skills-eval.it.test.ts` — endpoint integration test.
- **Create** `server/test/seed-skills.it.test.ts` — seed CLI flag idempotency.
- **Create** `server/test/run-executor-skills.it.test.ts` — production wiring regression.

### Client

- **Modify** `client/src/vendor/shared/contracts/knowledge.ts` — mirror server `PRFixtureMeta` + `SkillsEvalResult` shapes (manual sync per server/INSIGHTS.md 2026-06-23).
- **Modify** `client/src/lib/api.ts` — add `getEvalFixtures`, `runSkillsEval`.
- **Modify** `client/src/lib/hooks/agents.ts` — add `useEvalFixtures`, `useSkillsEval`.
- **Modify** `client/messages/en/agents.json` — add `skills.evalButton`, `skills.evalEmpty`, and `eval.*` keys.
- **Modify** `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.tsx` — render the "Compare with vs without skills" button when ≥1 link is enabled; mount `SkillsEvalModal` controlled by local state.
- **Create** `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/SkillsEvalModal/` tree:
  - `SkillsEvalModal.tsx`, `SkillsEvalModal.test.tsx`, `styles.ts`, `index.ts`
  - `_components/FixturePicker/` — `FixturePicker.tsx`, `FixturePicker.test.tsx`, `styles.ts`, `index.ts`
  - `_components/EvalResultsSplit/` — `EvalResultsSplit.tsx`, `EvalResultsSplit.test.tsx`, `styles.ts`, `index.ts`, plus a pure `diffFindings.ts` + `diffFindings.test.ts` next to it for the NEW/MISSING annotation logic.
  - `_components/FindingRow/` — `FindingRow.tsx`, `FindingRow.test.tsx`, `styles.ts`, `index.ts`

---

## Task Sequencing Notes

S1 (skills loader) lands first; S2 (run-executor wiring) consumes it. The shared contracts (S3) must land before the route (S5) and any client work. Seed (S6) is independent of the routes and can land in parallel with S4–S5. Client tasks (C1–C7) all assume S3 + S5.

---

## Task 1 [S1]: Skills loader (repo + service)

**Files:**
- Modify: `server/src/modules/agents/repository.ts`
- Modify: `server/src/modules/agents/service.ts`
- Test: `server/test/skills-loader.it.test.ts`

**Interfaces:**
- Consumes: existing `agent_skills` + `skills` tables; `linkedSkills(agentId)` already projects `enabled`.
- Produces:
  - `AgentsRepository.enabledSkillBodiesForAgent(agentId: string): Promise<string[]>` — ordered by `order` asc; only `enabled = true`; only `body` text (skips empty bodies).
  - `AgentsService.loadEnabledSkillBodies(agentId: string): Promise<string[]>` — thin wrapper; the boundary other modules consume.

- [ ] **Step 1: Write the failing test**

Create `server/test/skills-loader.it.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from './helpers/pg.js';
import { AgentsRepository } from '../src/modules/agents/repository.js';
import { AgentsService } from '../src/modules/agents/service.js';
import { Container } from '../src/platform/container.js';

describe('skills loader', () => {
  it('returns enabled skill bodies in order; skips disabled and empty bodies', async () => {
    await withTestDb(async (db, seedIds) => {
      const repo = new AgentsRepository(db);
      const agentId = await seedTestAgentWithSkills(db, seedIds.workspaceId, [
        { body: 'A', order: 0, enabled: true },
        { body: 'B', order: 1, enabled: false },
        { body: 'C', order: 2, enabled: true },
        { body: '',  order: 3, enabled: true },
      ]);

      const bodies = await repo.enabledSkillBodiesForAgent(agentId);

      expect(bodies).toEqual(['A', 'C']);
    });
  });

  it('service.loadEnabledSkillBodies returns the same as the repo', async () => {
    await withTestDb(async (db, seedIds) => {
      const container = { db, agentsRepo: new AgentsRepository(db) } as unknown as Container;
      const service = new AgentsService(container);
      const agentId = await seedTestAgentWithSkills(db, seedIds.workspaceId, [
        { body: 'only-one', order: 0, enabled: true },
      ]);

      expect(await service.loadEnabledSkillBodies(agentId)).toEqual(['only-one']);
    });
  });
});

// Helper local to this file: insert an agent + N skills + N links.
async function seedTestAgentWithSkills(
  db: import('../src/db/client.js').Db,
  workspaceId: string,
  skills: Array<{ body: string; order: number; enabled: boolean }>,
): Promise<string> {
  // Implementation: insert into agents (minimal valid row), insert into skills,
  // insert into agent_skills with order+enabled. Return agent.id.
  // Use the same test helper pattern as server/test/agent-skills-enabled.it.test.ts.
  throw new Error('TODO: copy seed pattern from agent-skills-enabled.it.test.ts');
}
```

Then port the seeding helper from `server/test/agent-skills-enabled.it.test.ts` (look at the analogous helper there and adapt).

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && pnpm exec vitest run skills-loader.it.test.ts
```

Expected: FAIL with "enabledSkillBodiesForAgent is not a function" (and the seed helper TODO).

- [ ] **Step 3: Implement the repo method**

Append to `server/src/modules/agents/repository.ts`, near `linkedSkills`:

```ts
async enabledSkillBodiesForAgent(agentId: string): Promise<string[]> {
  const rows = await this.db
    .select({ body: t.skills.body, order: t.agentSkills.order })
    .from(t.agentSkills)
    .innerJoin(t.skills, eq(t.agentSkills.skillId, t.skills.id))
    .where(and(eq(t.agentSkills.agentId, agentId), eq(t.agentSkills.enabled, true)))
    .orderBy(asc(t.agentSkills.order));
  return rows.map((r) => r.body).filter((b) => b.length > 0);
}
```

Append to `server/src/modules/agents/service.ts`:

```ts
/** Linked skill bodies (enabled only) in order — fed to reviewer-core's `skills` input. */
async loadEnabledSkillBodies(agentId: string): Promise<string[]> {
  return this.repo.enabledSkillBodiesForAgent(agentId);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && pnpm exec vitest run skills-loader.it.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/agents/repository.ts server/src/modules/agents/service.ts server/test/skills-loader.it.test.ts
git commit -m 'feat(server): enabledSkillBodiesForAgent + loadEnabledSkillBodies'
```

---

## Task 2 [S2]: Wire skills into the production review path

**Files:**
- Modify: `server/src/modules/reviews/run-executor.ts:155-212` (the `runOneAgent` body, where `reviewPullRequest` is called)
- Test: `server/test/run-executor-skills.it.test.ts`

**Interfaces:**
- Consumes: `AgentsService.loadEnabledSkillBodies(agentId)` from Task 1.
- Produces: every production review now resolves the agent's enabled linked-skill bodies and passes them to `reviewPullRequest({ skills })`. Disabled links → omitted. No linked skills → identical prompt to today.

- [ ] **Step 1: Write the failing test**

Create `server/test/run-executor-skills.it.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { withTestDb } from './helpers/pg.js';
// ... bootstrap helpers matching the existing run-executor integration tests.

describe('run-executor: linked skills wiring', () => {
  it('passes enabled skill bodies to reviewPullRequest, in order; skips disabled', async () => {
    // Arrange: a fake LLM provider that captures the assembled prompt parts.
    const captured: string[][] = [];
    const fakeLlm = makeCapturingLlm((skills) => captured.push(skills ?? []));

    await withTestDb(async (db, seedIds) => {
      // Seed: an agent with 3 linked skills (orders 0,1,2; middle one disabled).
      const { agentId, prId, repo } = await seedAgentAndPr(db, seedIds, [
        { body: 'SKILL-A', order: 0, enabled: true },
        { body: 'SKILL-B', order: 1, enabled: false },
        { body: 'SKILL-C', order: 2, enabled: true },
      ]);

      const executor = buildExecutorWithLlm(db, fakeLlm);
      await executor.executeRuns(seedIds.workspaceId, /* pull */ ..., repo, [{ agent: /* agentRow */, runId: 'r1' }]);

      expect(captured).toHaveLength(1);
      expect(captured[0]).toEqual(['SKILL-A', 'SKILL-C']);
    });
  });

  it('omits skills entirely when no links are enabled', async () => {
    // Same harness, no enabled links → captured[0] is undefined or [].
    // Reviewer-core's assemblePrompt drops the section either way.
  });
});
```

(The harness helpers `makeCapturingLlm`, `seedAgentAndPr`, `buildExecutorWithLlm` follow the existing pattern in `server/test/review-pipeline.it.test.ts` or equivalent — copy and adapt.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && pnpm exec vitest run run-executor-skills.it.test.ts
```

Expected: FAIL — `captured[0]` is `undefined` (no skills passed today).

- [ ] **Step 3: Wire it in**

In `server/src/modules/reviews/run-executor.ts`, locate the `reviewPullRequest(...)` call inside `runOneAgent` (around line 190). Resolve skills before the call and thread them in. Add the AgentsService dependency via the container:

```ts
// Near the top of runOneAgent, alongside repoIntel resolution:
const skillBodies = await this.container.agentsService.loadEnabledSkillBodies(agent.id);
if (skillBodies.length > 0) {
  runLog.info(`Loaded ${skillBodies.length} skill body/bodies for agent "${agent.name}"`);
}

const outcome = await reviewPullRequest({
  systemPrompt: agent.systemPrompt,
  model: agent.model,
  diff,
  llm,
  strategy: agent.strategy ?? REVIEW_STRATEGY,
  ...(skillBodies.length > 0 ? { skills: skillBodies } : {}),
  ...(callersDigest ? { callers: callersDigest } : {}),
  // … rest unchanged
});
```

If `this.container.agentsService` doesn't exist yet on the container shape, add a thin getter alongside `agentsRepo` in `server/src/platform/container.ts`. (Inspect the file first; the executor already uses `this.container.runBus`, `this.container.llm`, etc.)

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && pnpm exec vitest run run-executor-skills.it.test.ts
# Also run the full review pipeline tests to make sure no regression:
cd server && pnpm exec vitest run review-pipeline
```

Expected: PASS on both.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/reviews/run-executor.ts server/src/platform/container.ts server/test/run-executor-skills.it.test.ts
git commit -m 'feat(server): run-executor passes enabled linked-skill bodies to reviewer-core'
```

---

## Task 3 [S3]: Shared contract — PRFixtureMeta + SkillsEvalResult

**Files:**
- Modify: `server/src/vendor/shared/contracts/knowledge.ts`
- Modify: `client/src/vendor/shared/contracts/knowledge.ts` (manual mirror)
- Test: server typecheck + client typecheck

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PRFixtureMeta = { id, title, notes? }` (Zod object + inferred type).
  - `SkillsEvalSide = { findings: Finding[], grounding: string, tokensIn: number, tokensOut: number, costUsd: number | null }`.
  - `SkillsEvalResult = { with_skills: SkillsEvalSide, without_skills: SkillsEvalSide, fixture: PRFixtureMeta }`.

`Finding` is already in the shared contracts. Don't duplicate it — import.

- [ ] **Step 1: Add to the SERVER vendored copy**

Append to the end of `server/src/vendor/shared/contracts/knowledge.ts` (after the existing `AgentSkillLink` etc.):

```ts
// ---- Spec D: Skills A/B eval -------------------------------------------------

export const PRFixtureMeta = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  notes: z.string().optional(),
});
export type PRFixtureMeta = z.infer<typeof PRFixtureMeta>;

export const SkillsEvalSide = z.object({
  findings: z.array(Finding),
  grounding: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  costUsd: z.number().nullable(),
});
export type SkillsEvalSide = z.infer<typeof SkillsEvalSide>;

export const SkillsEvalResult = z.object({
  with_skills: SkillsEvalSide,
  without_skills: SkillsEvalSide,
  fixture: PRFixtureMeta,
});
export type SkillsEvalResult = z.infer<typeof SkillsEvalResult>;
```

(`Finding` is already exported from the same file. If not, import it from wherever it lives — same module.)

- [ ] **Step 2: Mirror to the CLIENT vendored copy**

Append the identical block to `client/src/vendor/shared/contracts/knowledge.ts`. (Per server/INSIGHTS.md 2026-06-23, the two copies are manually synced.)

- [ ] **Step 3: Verify typecheck on both sides**

```bash
cd server && pnpm typecheck
cd ../client && pnpm typecheck
```

Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/vendor/shared/contracts/knowledge.ts client/src/vendor/shared/contracts/knowledge.ts
git commit -m 'feat(shared): PRFixtureMeta + SkillsEvalResult contracts'
```

---

## Task 4 [S4]: Eval fixtures — loader + two fixture files

**Files:**
- Create: `server/src/modules/agents/eval-fixtures.ts`
- Create: `server/test/fixtures/prs/test-only-happy-path.json`
- Create: `server/test/fixtures/prs/api-contract-change.json`
- Test: `server/test/eval-fixtures.test.ts`

**Interfaces:**
- Consumes: `PRFixtureMeta` from Task 3; `UnifiedDiff` from `@devdigest/shared`; `parseUnifiedDiff` from `server/src/adapters/git/diff-parser.ts`.
- Produces:
  - `interface PRFixture { id: string; title: string; notes?: string; diff: string; }` (raw on-disk shape).
  - `interface PRFixtureLoaded { meta: PRFixtureMeta; unifiedDiff: UnifiedDiff; }` (parsed at load).
  - `listFixtures(): PRFixtureMeta[]` — sorted by `id` asc.
  - `loadFixture(id: string): PRFixtureLoaded | undefined`.
  - On first call, scans `server/test/fixtures/prs/*.json`, validates each against a Zod schema, parses the diff, caches in memory. Throws on malformed JSON or schema-fail (server fail-fast).

- [ ] **Step 1: Write the fixture files**

`server/test/fixtures/prs/test-only-happy-path.json`:

```json
{
  "id": "test-only-happy-path",
  "title": "Add discount calculation + happy-path test",
  "notes": "Test Quality target: should flag the missing branch coverage (negative discount, > 100% discount, zero-price item).",
  "diff": "diff --git a/src/discount.ts b/src/discount.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/discount.ts\n@@ -0,0 +1,7 @@\n+export function applyDiscount(price: number, percent: number): number {\n+  if (percent <= 0) return price;\n+  if (percent >= 100) return 0;\n+  return Math.round(price * (1 - percent / 100));\n+}\n+\n+\ndiff --git a/test/discount.test.ts b/test/discount.test.ts\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/test/discount.test.ts\n@@ -0,0 +1,7 @@\n+import { describe, it, expect } from 'vitest';\n+import { applyDiscount } from '../src/discount';\n+\n+describe('applyDiscount', () => {\n+  it('applies a normal discount', () => {\n+    expect(applyDiscount(100, 20)).toBe(80);\n+  });\n+});\n"
}
```

`server/test/fixtures/prs/api-contract-change.json`:

```json
{
  "id": "api-contract-change",
  "title": "Change /users/:id response shape",
  "notes": "API Contract target: 'email' field renamed to 'emailAddress' on a public route — breaking change for any consumer.",
  "diff": "diff --git a/src/routes/users.ts b/src/routes/users.ts\nindex aaaaaaa..bbbbbbb 100644\n--- a/src/routes/users.ts\n+++ b/src/routes/users.ts\n@@ -10,7 +10,7 @@ export const UserResponse = z.object({\n   id: z.string(),\n   name: z.string(),\n-  email: z.string(),\n+  emailAddress: z.string(),\n   createdAt: z.string(),\n });\n\n@@ -25,7 +25,7 @@ app.get('/users/:id', async (req, reply) => {\n   return reply.send({\n     id: user.id,\n     name: user.name,\n-    email: user.email,\n+    emailAddress: user.email,\n     createdAt: user.createdAt.toISOString(),\n   });\n });\n"
}
```

- [ ] **Step 2: Write the failing test**

Create `server/test/eval-fixtures.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { listFixtures, loadFixture } from '../src/modules/agents/eval-fixtures.js';

describe('eval-fixtures', () => {
  it('lists both shipped fixtures by id', () => {
    const ids = listFixtures().map((f) => f.id);
    expect(ids).toEqual(['api-contract-change', 'test-only-happy-path']); // sorted
  });

  it('loadFixture returns meta + a parsed UnifiedDiff for a known id', () => {
    const fx = loadFixture('test-only-happy-path');
    expect(fx).toBeDefined();
    expect(fx!.meta.title).toMatch(/discount/i);
    expect(fx!.unifiedDiff.files.length).toBeGreaterThan(0);
    expect(fx!.unifiedDiff.files[0]!.hunks.length).toBeGreaterThan(0);
  });

  it('loadFixture returns undefined for an unknown id', () => {
    expect(loadFixture('does-not-exist')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd server && pnpm exec vitest run eval-fixtures.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement the loader**

Create `server/src/modules/agents/eval-fixtures.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { UnifiedDiff } from '@devdigest/shared';
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';
import type { PRFixtureMeta as PRFixtureMetaT } from '../../vendor/shared/contracts/knowledge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Fixtures live under server/test/fixtures/prs — resolve relative to this file:
// server/src/modules/agents/eval-fixtures.ts → ../../../../test/fixtures/prs
const FIXTURE_DIR = join(__dirname, '../../../../test/fixtures/prs');

const PRFixtureFile = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  notes: z.string().optional(),
  diff: z.string().min(1),
});

export interface PRFixtureLoaded {
  meta: PRFixtureMetaT;
  unifiedDiff: UnifiedDiff;
}

let cache: Map<string, PRFixtureLoaded> | null = null;

function loadAll(): Map<string, PRFixtureLoaded> {
  if (cache) return cache;
  const map = new Map<string, PRFixtureLoaded>();
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const raw = readFileSync(join(FIXTURE_DIR, file), 'utf-8');
    const parsed = PRFixtureFile.parse(JSON.parse(raw));
    const unifiedDiff = parseUnifiedDiff(parsed.diff);
    map.set(parsed.id, {
      meta: { id: parsed.id, title: parsed.title, notes: parsed.notes },
      unifiedDiff,
    });
  }
  cache = map;
  return map;
}

export function listFixtures(): PRFixtureMetaT[] {
  const all = Array.from(loadAll().values()).map((f) => f.meta);
  return all.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadFixture(id: string): PRFixtureLoaded | undefined {
  return loadAll().get(id);
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd server && pnpm exec vitest run eval-fixtures.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/agents/eval-fixtures.ts server/test/fixtures/prs/ server/test/eval-fixtures.test.ts
git commit -m 'feat(server): eval-fixtures loader + two seed PR fixtures'
```

---

## Task 5 [S5]: Service — `evaluateSkillsAB`

**Files:**
- Modify: `server/src/modules/agents/service.ts`
- Test: covered by Task 7 (endpoint test) — no separate test file. (Per task-right-sizing: the service is a thin orchestrator; testing through the route gives equal coverage with less mocking.)

**Interfaces:**
- Consumes: `loadEnabledSkillBodies` (Task 1); `loadFixture` (Task 4); `reviewPullRequest` from `@devdigest/reviewer-core`; `container.llm(provider)` to resolve the LLM.
- Produces:
  ```ts
  async evaluateSkillsAB(
    workspaceId: string,
    agentId: string,
    fixtureId: string,
  ): Promise<SkillsEvalResult | undefined>
  ```
  Returns `undefined` if agent missing (404 surface). Throws `NotFoundError` for the fixture if missing (separate 404 reason). Two sequential `reviewPullRequest` calls.

- [ ] **Step 1: Implement (no separate failing test)**

In `server/src/modules/agents/service.ts`, append (after `unlinkSkill`):

```ts
async evaluateSkillsAB(
  workspaceId: string,
  agentId: string,
  fixtureId: string,
): Promise<SkillsEvalResult | undefined> {
  const agent = await this.repo.getById(workspaceId, agentId);
  if (!agent) return undefined;

  const fx = loadFixture(fixtureId);
  if (!fx) throw new NotFoundError(`Fixture "${fixtureId}" not found`);

  const skillBodies = await this.loadEnabledSkillBodies(agentId);
  const llm = await this.container.llm(agent.provider as Provider);

  const runOnce = async (skills: string[] | undefined): Promise<SkillsEvalSide> => {
    const outcome = await reviewPullRequest({
      systemPrompt: agent.systemPrompt,
      model: agent.model,
      diff: fx.unifiedDiff,
      llm,
      strategy: agent.strategy ?? 'auto',
      ...(skills && skills.length > 0 ? { skills } : {}),
      task: `Skills A/B eval · ${fx.meta.title}`,
      sessionId: `skills-eval:${agentId}:${fixtureId}`,
    });
    return {
      findings: outcome.review.findings,
      grounding: outcome.grounding,
      tokensIn: outcome.tokensIn,
      tokensOut: outcome.tokensOut,
      costUsd: outcome.costUsd,
    };
  };

  const with_skills = await runOnce(skillBodies);
  const without_skills = await runOnce([]);

  return { with_skills, without_skills, fixture: fx.meta };
}
```

Add the needed imports at the top of the file: `loadFixture` from `./eval-fixtures.js`, `reviewPullRequest` from `@devdigest/reviewer-core`, `Provider` from `@devdigest/shared`, `NotFoundError` from `../../platform/errors.js`, and the contract types `SkillsEvalResult`, `SkillsEvalSide` from `../../vendor/shared/contracts/knowledge.js`.

- [ ] **Step 2: Typecheck**

```bash
cd server && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/agents/service.ts
git commit -m 'feat(server): AgentsService.evaluateSkillsAB runs reviewer-core twice (with/without skills)'
```

---

## Task 6 [S6]: Seed extension — `--with-skills` flag

**Files:**
- Create: `server/src/db/seed-skills.ts`
- Modify: `server/src/db/seed.ts`
- Test: `server/test/seed-skills.it.test.ts`

**Interfaces:**
- Consumes: existing `seed.ts` workspaceId/userId.
- Produces:
  - `TEST_COVERAGE_NUDGE` (string) — skill body for `test-coverage-nudge`.
  - `API_CONTRACT_GATE` (string) — skill body for `api-contract-gate`.
  - `seedWithSkills(db, workspaceId, userId): Promise<void>` — upserts the two skills, the Test Quality Reviewer agent, and links both (`order: 0, 1`, `enabled: true`). Idempotent.
  - `seed.ts` reads `process.argv.includes('--with-skills')` to call `seedWithSkills` after the default seed.

- [ ] **Step 1: Write the failing test**

Create `server/test/seed-skills.it.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { withTestDb } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import { seedWithSkills } from '../src/db/seed-skills.js';
import * as t from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

describe('seed --with-skills', () => {
  it('default seed leaves the Test Quality agent + new skills absent', async () => {
    await withTestDb(async (db) => {
      await seed(db);
      const skills = await db.select().from(t.skills);
      expect(skills.find((s) => s.slug === 'test-coverage-nudge')).toBeUndefined();
      const agents = await db.select().from(t.agents);
      expect(agents.find((a) => a.name === 'Test Quality Reviewer')).toBeUndefined();
    });
  });

  it('seedWithSkills creates the agent + both skills, links both', async () => {
    await withTestDb(async (db) => {
      const { workspaceId, userId } = await seed(db);
      await seedWithSkills(db, workspaceId, userId);

      const skills = await db.select().from(t.skills);
      expect(skills.find((s) => s.slug === 'test-coverage-nudge')).toBeDefined();
      expect(skills.find((s) => s.slug === 'api-contract-gate')).toBeDefined();

      const agent = (await db.select().from(t.agents).where(eq(t.agents.name, 'Test Quality Reviewer')))[0];
      expect(agent).toBeDefined();

      const links = await db.select().from(t.agentSkills).where(eq(t.agentSkills.agentId, agent!.id));
      expect(links).toHaveLength(2);
      expect(links.every((l) => l.enabled === true)).toBe(true);
    });
  });

  it('seedWithSkills is idempotent', async () => {
    await withTestDb(async (db) => {
      const { workspaceId, userId } = await seed(db);
      await seedWithSkills(db, workspaceId, userId);
      await seedWithSkills(db, workspaceId, userId);

      const skills = await db.select().from(t.skills);
      const agents = await db.select().from(t.agents).where(eq(t.agents.name, 'Test Quality Reviewer'));
      const links = await db.select().from(t.agentSkills).where(eq(t.agentSkills.agentId, agents[0]!.id));

      // Exactly one of each — no duplicates.
      expect(agents).toHaveLength(1);
      expect(skills.filter((s) => s.slug === 'test-coverage-nudge')).toHaveLength(1);
      expect(skills.filter((s) => s.slug === 'api-contract-gate')).toHaveLength(1);
      expect(links).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && pnpm exec vitest run seed-skills.it.test.ts
```

Expected: FAIL — `seed-skills` module doesn't exist.

- [ ] **Step 3: Implement seed-skills.ts**

Create `server/src/db/seed-skills.ts`:

```ts
import type { Db } from './client.js';
import * as t from './schema.js';
import { eq, and } from 'drizzle-orm';

export const TEST_COVERAGE_NUDGE = `# Test Coverage Nudge

You are reviewing a pull request that adds or modifies test files. Examine the diff for the following test-quality issues and flag each one with a precise \`file:line\` citation:

1. **Happy-path-only tests.** If a function under test has branches (early returns, error paths, conditional logic) and only the success path is asserted, flag the untested branch(es) explicitly: "X tests the happy path; missing case Y at file:line".
2. **Missing edge cases.** For each new function, ask: what happens at 0, negative inputs, empty arrays, undefined, max-value, off-by-one boundaries? If a clearly relevant edge case is not exercised, flag it.
3. **Over-mocking.** A test that mocks the subject under test, mocks every collaborator, or asserts only against mock call counts (not real behavior) is a smell. Flag with: "Mock-heavy: this asserts the test setup, not the behavior".
4. **Likely flakes.** Time-dependent assertions (\`Date.now()\`, \`setTimeout\`), order-dependent iteration over hash maps, network calls without a fake, race-prone concurrency without a sync barrier — flag each with the specific concern.

For every finding, cite the exact file and line from the diff. Do not invent line numbers. If you cannot ground a concern to a specific line, do not emit it.
`;

export const API_CONTRACT_GATE = `# API Contract Gate

You are reviewing a pull request that may change a public API contract. Examine the diff for the following breaking-change patterns and flag each one with severity \`error\` and a precise \`file:line\` citation:

1. **Renamed or removed response fields** on any route's response schema (Zod, JSON Schema, OpenAPI). Existing clients will break. Flag with: "Breaking: response field X renamed to Y at file:line".
2. **Tightened request validation** — a field that was optional becoming required, an enum gaining a non-additive constraint, a string field gaining a min-length or pattern that prior valid requests would fail. Flag with: "Breaking: request validation tightened at file:line".
3. **Removed routes** or removed methods on a route. Flag with: "Breaking: route X removed at file:line".
4. **Changed HTTP status semantics** — a route that used to return 200 now returning 201 or 204, or a 4xx becoming a 5xx. Flag with: "Breaking: status code change at file:line".
5. **Removed query/path parameters** or renamed them. Flag with: "Breaking: parameter renamed/removed at file:line".

For every finding, cite the exact file and line from the diff. Additive changes (new optional fields, new routes, new optional query params) are NOT breaking and should NOT be flagged.
`;

const TEST_QUALITY_SYSTEM_PROMPT = `You are a Test Quality Reviewer. Examine the diff for missing branch coverage, untested edge cases, over-mocking, and likely flakes. Cite exact file:line. Be precise; do not invent findings.`;

export async function seedWithSkills(db: Db, workspaceId: string, userId: string): Promise<void> {
  // ---- Skills ----
  const skillsToUpsert = [
    { slug: 'test-coverage-nudge', name: 'Test Coverage Nudge', type: 'rubric' as const, body: TEST_COVERAGE_NUDGE },
    { slug: 'api-contract-gate', name: 'API Contract Gate', type: 'security' as const, body: API_CONTRACT_GATE },
  ];
  const skillRows: { id: string; slug: string }[] = [];
  for (const s of skillsToUpsert) {
    const existing = await db.select().from(t.skills).where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.slug, s.slug)));
    if (existing[0]) {
      skillRows.push({ id: existing[0].id, slug: s.slug });
      continue;
    }
    const [row] = await db
      .insert(t.skills)
      .values({ workspaceId, slug: s.slug, name: s.name, type: s.type, body: s.body, createdBy: userId })
      .returning();
    skillRows.push({ id: row!.id, slug: s.slug });
  }

  // ---- Agent ----
  const existingAgent = await db
    .select()
    .from(t.agents)
    .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, 'Test Quality Reviewer')));
  let agentId: string;
  if (existingAgent[0]) {
    agentId = existingAgent[0].id;
  } else {
    const [row] = await db
      .insert(t.agents)
      .values({
        workspaceId,
        name: 'Test Quality Reviewer',
        description: 'Flags missing branches, edge cases, mock overuse, and likely flakes in test diffs.',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: TEST_QUALITY_SYSTEM_PROMPT,
        enabled: true,
      })
      .returning();
    agentId = row!.id;
  }

  // ---- Links ----
  for (let i = 0; i < skillRows.length; i++) {
    await db
      .insert(t.agentSkills)
      .values({ agentId, skillId: skillRows[i]!.id, order: i, enabled: true })
      .onConflictDoNothing();
  }
}
```

(Verify column names against `schema/agents.ts` and `schema/skills.ts` — adjust if the actual columns are e.g. `system_prompt` vs `systemPrompt` on the Drizzle side.)

- [ ] **Step 4: Wire the CLI flag in seed.ts**

In `server/src/db/seed.ts`, locate the CLI bottom of the file (after `seed(db)` is called for the bin path). Extend it:

```ts
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  const withSkills = process.argv.includes('--with-skills');
  const db = createDb();
  seed(db)
    .then(async ({ workspaceId, userId }) => {
      if (withSkills) {
        const { seedWithSkills } = await import('./seed-skills.js');
        await seedWithSkills(db, workspaceId, userId);
        console.log('Seeded Test Quality Reviewer + skills.');
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
```

(Inspect the existing CLI tail of seed.ts first — pattern may differ. Adapt.)

- [ ] **Step 5: Run test to verify it passes**

```bash
cd server && pnpm exec vitest run seed-skills.it.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/seed-skills.ts server/src/db/seed.ts server/test/seed-skills.it.test.ts
git commit -m 'feat(server): seed --with-skills creates Test Quality Reviewer + 2 skills'
```

---

## Task 7 [S7]: Routes — `GET /agents/eval-fixtures` + `POST /agents/:id/skills-eval`

**Files:**
- Modify: `server/src/modules/agents/routes.ts`
- Test: `server/test/skills-eval.it.test.ts`

**Interfaces:**
- Consumes: `evaluateSkillsAB` (Task 5); `listFixtures` (Task 4); `SkillsEvalResult` + `PRFixtureMeta` schemas (Task 3).
- Produces:
  - `GET /agents/eval-fixtures` → `PRFixtureMeta[]`.
  - `POST /agents/:id/skills-eval` body `{ fixture_id: string }` → `SkillsEvalResult`. 404 on missing agent (cross-workspace defense). 404 on unknown fixture. 422 on body shape.

- [ ] **Step 1: Write the failing test**

Create `server/test/skills-eval.it.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildApp, withTestDb } from './helpers/app.js';
// ... existing helpers; adapt from server/test/agent-skills-enabled.it.test.ts

describe('POST /agents/:id/skills-eval', () => {
  it('returns both sides + fixture meta on the happy path', async () => {
    await withTestDb(async (db, seedIds) => {
      // Seed: an agent in workspace + a linked skill (enabled).
      const agentId = await seedAgentWithSkill(db, seedIds.workspaceId);
      const app = await buildApp({ db, llmFactory: makeMockLlm() });

      const res = await app.inject({
        method: 'POST',
        url: \`/agents/\${agentId}/skills-eval\`,
        payload: { fixture_id: 'test-only-happy-path' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.fixture.id).toBe('test-only-happy-path');
      expect(body.with_skills).toBeDefined();
      expect(body.without_skills).toBeDefined();
    });
  });

  it('404 on unknown agent', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp({ db });
      const res = await app.inject({
        method: 'POST',
        url: '/agents/00000000-0000-0000-0000-000000000000/skills-eval',
        payload: { fixture_id: 'test-only-happy-path' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it('404 on cross-workspace agent', async () => {
    await withTestDb(async (db, seedIds) => {
      const otherWsAgentId = await seedAgentInOtherWorkspace(db);
      const app = await buildApp({ db });
      const res = await app.inject({
        method: 'POST',
        url: \`/agents/\${otherWsAgentId}/skills-eval\`,
        payload: { fixture_id: 'test-only-happy-path' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it('404 on unknown fixture', async () => {
    await withTestDb(async (db, seedIds) => {
      const agentId = await seedAgentWithSkill(db, seedIds.workspaceId);
      const app = await buildApp({ db });
      const res = await app.inject({
        method: 'POST',
        url: \`/agents/\${agentId}/skills-eval\`,
        payload: { fixture_id: 'no-such-fixture' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it('422 on malformed body', async () => {
    await withTestDb(async (db, seedIds) => {
      const agentId = await seedAgentWithSkill(db, seedIds.workspaceId);
      const app = await buildApp({ db });
      const res = await app.inject({
        method: 'POST',
        url: \`/agents/\${agentId}/skills-eval\`,
        payload: { wrong_key: 'x' },
      });
      expect(res.statusCode).toBe(422);
    });
  });

  it('does not mutate the DB during eval', async () => {
    await withTestDb(async (db, seedIds) => {
      const agentId = await seedAgentWithSkill(db, seedIds.workspaceId);
      const beforeAgentSkills = await db.select().from(t.agentSkills);
      const app = await buildApp({ db, llmFactory: makeMockLlm() });

      await app.inject({
        method: 'POST',
        url: \`/agents/\${agentId}/skills-eval\`,
        payload: { fixture_id: 'test-only-happy-path' },
      });

      const afterAgentSkills = await db.select().from(t.agentSkills);
      expect(afterAgentSkills).toEqual(beforeAgentSkills);
    });
  });
});

describe('GET /agents/eval-fixtures', () => {
  it('returns both fixtures', async () => {
    await withTestDb(async (db) => {
      const app = await buildApp({ db });
      const res = await app.inject({ method: 'GET', url: '/agents/eval-fixtures' });
      expect(res.statusCode).toBe(200);
      const fixtures = res.json();
      expect(fixtures.map((f: any) => f.id)).toEqual([
        'api-contract-change',
        'test-only-happy-path',
      ]);
    });
  });
});
```

(Adapt helper imports to match the actual test harness. `makeMockLlm` returns a capturing/scripted provider — copy the shape from existing review-pipeline tests.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && pnpm exec vitest run skills-eval.it.test.ts
```

Expected: FAIL — routes don't exist.

- [ ] **Step 3: Add the routes**

In `server/src/modules/agents/routes.ts`, after the existing `DELETE /:id/skills/:skillId` route, add:

```ts
// ---- GET /agents/eval-fixtures --------------------------------------------
app.route({
  method: 'GET',
  url: '/agents/eval-fixtures',
  schema: { response: { 200: z.array(PRFixtureMeta) } },
  handler: async () => {
    const { listFixtures } = await import('./eval-fixtures.js');
    return listFixtures();
  },
});

// ---- POST /agents/:id/skills-eval ------------------------------------------
const SkillsEvalBody = z.object({ fixture_id: z.string().min(1) });

app.route({
  method: 'POST',
  url: '/agents/:id/skills-eval',
  schema: {
    params: IdParams,
    body: SkillsEvalBody,
    response: { 200: SkillsEvalResult },
  },
  handler: async (req) => {
    const { workspaceId } = getContext(req);
    const { id } = req.params;
    const { fixture_id } = req.body;
    const result = await service.evaluateSkillsAB(workspaceId, id, fixture_id);
    if (!result) throw new NotFoundError(\`Agent \${id} not found\`);
    return result;
  },
});
```

Add imports at top of routes.ts: `PRFixtureMeta`, `SkillsEvalResult` from `../../vendor/shared/contracts/knowledge.js`.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd server && pnpm exec vitest run skills-eval.it.test.ts
```

Expected: PASS on all cases.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/agents/routes.ts server/test/skills-eval.it.test.ts
git commit -m 'feat(server): GET /agents/eval-fixtures + POST /agents/:id/skills-eval'
```

---

## Task 8 [C1]: Client API + hooks

**Files:**
- Modify: `client/src/lib/api.ts`
- Modify: `client/src/lib/hooks/agents.ts`
- Test: skipped — the hooks are thin TanStack Query wrappers covered transitively by the modal tests in Task 12.

**Interfaces:**
- Consumes: `PRFixtureMeta`, `SkillsEvalResult` from `client/src/vendor/shared/contracts/knowledge.ts` (Task 3 mirror).
- Produces:
  - `api.getEvalFixtures(): Promise<PRFixtureMeta[]>`.
  - `api.runSkillsEval(agentId: string, fixtureId: string): Promise<SkillsEvalResult>`.
  - `useEvalFixtures(): UseQueryResult<PRFixtureMeta[]>` — query key `['eval-fixtures']`, `staleTime: Infinity` (server data is build-time).
  - `useSkillsEval(agentId: string): UseMutationResult<SkillsEvalResult, Error, { fixture_id: string }>` — no cache invalidation (read-only eval, no DB writes).

- [ ] **Step 1: Add to `client/src/lib/api.ts`**

Following the existing `api.*` shape (look for `linkAgentSkill` or similar), add:

```ts
async getEvalFixtures(): Promise<PRFixtureMeta[]> {
  const res = await this.fetch('/agents/eval-fixtures');
  return PRFixtureMeta.array().parse(await res.json());
},

async runSkillsEval(agentId: string, fixtureId: string): Promise<SkillsEvalResult> {
  const res = await this.fetch(\`/agents/\${agentId}/skills-eval\`, {
    method: 'POST',
    body: JSON.stringify({ fixture_id: fixtureId }),
  });
  return SkillsEvalResult.parse(await res.json());
},
```

Add the imports: `PRFixtureMeta`, `SkillsEvalResult` from `'@/vendor/shared/contracts/knowledge'` (or wherever the client's alias resolves to the vendored copy).

- [ ] **Step 2: Add to `client/src/lib/hooks/agents.ts`**

```ts
export function useEvalFixtures() {
  return useQuery({
    queryKey: ['eval-fixtures'],
    queryFn: () => api.getEvalFixtures(),
    staleTime: Infinity,
  });
}

export function useSkillsEval(agentId: string) {
  return useMutation({
    mutationFn: ({ fixture_id }: { fixture_id: string }) => api.runSkillsEval(agentId, fixture_id),
  });
}
```

- [ ] **Step 3: Typecheck**

```bash
cd client && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/api.ts client/src/lib/hooks/agents.ts
git commit -m 'feat(client): useEvalFixtures + useSkillsEval hooks'
```

---

## Task 9 [C2]: i18n strings

**Files:**
- Modify: `client/messages/en/agents.json`
- Test: typecheck (locale messages are typed via the project's i18n setup).

**Interfaces:**
- Consumes: nothing.
- Produces: keys consumed by Tasks 10–14.

- [ ] **Step 1: Append the keys**

In `client/messages/en/agents.json`, under the existing `skills` object (added in Spec B), add:

```json
"evalButton": "Compare with vs without skills",
"evalEmpty": "Link at least one enabled skill to compare."
```

Add a new top-level `eval` object:

```json
"eval": {
  "title": "Skills A/B",
  "subtitle": "Run this agent on a packaged PR fixture, once with linked skills and once without. Two LLM calls.",
  "fixtureLabel": "PR fixture",
  "run": "Run comparison",
  "running": "Running…",
  "withColumn": "With skills",
  "withoutColumn": "Without skills",
  "noFindings": "No findings",
  "badge": {
    "new": "NEW",
    "missing": "MISSING"
  },
  "tokens": "{n} tokens",
  "cost": "${cost}",
  "noFixtures": "No fixtures available.",
  "error": "Could not run the comparison.",
  "retry": "Retry",
  "close": "Close",
  "cancel": "Cancel"
}
```

- [ ] **Step 2: Typecheck**

```bash
cd client && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/messages/en/agents.json
git commit -m 'feat(client): i18n strings for Skills A/B eval modal'
```

---

## Task 10 [C3]: `diffFindings` — pure NEW/MISSING annotation

**Files:**
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/SkillsEvalModal/_components/EvalResultsSplit/diffFindings.ts`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/SkillsEvalModal/_components/EvalResultsSplit/diffFindings.test.ts`

**Interfaces:**
- Consumes: `Finding` from the shared contracts.
- Produces:
  ```ts
  export type AnnotatedFinding = Finding & { annotation: 'new' | 'missing' | 'shared' };
  export function diffFindings(
    withSkills: Finding[],
    withoutSkills: Finding[],
  ): { withAnnotated: AnnotatedFinding[]; withoutAnnotated: AnnotatedFinding[] };
  ```
  Matching rule (per spec decision 5): exact `(file, line)` match required; messages compared via lowercase substring presence (`normalize(a).includes(normalize(b)) || normalize(b).includes(normalize(a))`). `normalize` lowercases + strips non-alphanumeric.

- [ ] **Step 1: Write the failing test**

Create the test file:

```ts
import { describe, it, expect } from 'vitest';
import { diffFindings } from './diffFindings.js';

const f = (file: string, line: number, message: string, severity = 'warning' as const) => ({
  file, line, message, severity, category: 'test', /* other Finding fields as needed */
});

describe('diffFindings', () => {
  it('marks unique-to-with findings as new', () => {
    const w = [f('a.ts', 1, 'X'), f('b.ts', 2, 'Y')];
    const wo = [f('a.ts', 1, 'X')];
    const out = diffFindings(w, wo);
    expect(out.withAnnotated.map((x) => x.annotation)).toEqual(['shared', 'new']);
    expect(out.withoutAnnotated.map((x) => x.annotation)).toEqual(['shared']);
  });

  it('marks unique-to-without findings as missing', () => {
    const w: any[] = [];
    const wo = [f('a.ts', 1, 'Z')];
    const out = diffFindings(w, wo);
    expect(out.withoutAnnotated[0]!.annotation).toBe('missing');
  });

  it('matches messages via normalised substring', () => {
    const w = [f('a.ts', 1, 'Missing branch: negative discount.')];
    const wo = [f('a.ts', 1, 'missing branch negative discount')];
    const out = diffFindings(w, wo);
    expect(out.withAnnotated[0]!.annotation).toBe('shared');
    expect(out.withoutAnnotated[0]!.annotation).toBe('shared');
  });

  it('different file or different line does not match even if message matches', () => {
    const w = [f('a.ts', 1, 'X')];
    const wo = [f('a.ts', 2, 'X')];
    const out = diffFindings(w, wo);
    expect(out.withAnnotated[0]!.annotation).toBe('new');
    expect(out.withoutAnnotated[0]!.annotation).toBe('missing');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd client && pnpm exec vitest run diffFindings.test
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement diffFindings.ts**

```ts
import type { Finding } from '@/vendor/shared/contracts/knowledge';

export type AnnotatedFinding = Finding & { annotation: 'new' | 'missing' | 'shared' };

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function similar(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length === 0 || nb.length === 0) return na === nb;
  return na.includes(nb) || nb.includes(na);
}

function findMatch(needle: Finding, haystack: Finding[]): Finding | undefined {
  return haystack.find(
    (f) => f.file === needle.file && f.line === needle.line && similar(f.message, needle.message),
  );
}

export function diffFindings(
  withSkills: Finding[],
  withoutSkills: Finding[],
): { withAnnotated: AnnotatedFinding[]; withoutAnnotated: AnnotatedFinding[] } {
  const withAnnotated = withSkills.map<AnnotatedFinding>((f) => ({
    ...f,
    annotation: findMatch(f, withoutSkills) ? 'shared' : 'new',
  }));
  const withoutAnnotated = withoutSkills.map<AnnotatedFinding>((f) => ({
    ...f,
    annotation: findMatch(f, withSkills) ? 'shared' : 'missing',
  }));
  return { withAnnotated, withoutAnnotated };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd client && pnpm exec vitest run diffFindings.test
```

Expected: PASS on all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/agents/\[id\]/_components/AgentEditor/_components/SkillsTab/_components/SkillsEvalModal/_components/EvalResultsSplit/diffFindings.ts \
        client/src/app/agents/\[id\]/_components/AgentEditor/_components/SkillsTab/_components/SkillsEvalModal/_components/EvalResultsSplit/diffFindings.test.ts
git commit -m 'feat(client): diffFindings pure helper (NEW/MISSING annotation)'
```

---

## Task 11 [C4]: `FindingRow` component

**Files:**
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/SkillsEvalModal/_components/FindingRow/FindingRow.tsx`
- Create: `.../FindingRow.test.tsx`
- Create: `.../styles.ts`
- Create: `.../index.ts`

**Interfaces:**
- Consumes: `AnnotatedFinding` from Task 10.
- Produces: `FindingRow({ finding }: { finding: AnnotatedFinding }): JSX.Element` — renders severity dot · `file:line` · message · optional `NEW`/`MISSING` badge. Pure presentational.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FindingRow } from './FindingRow.js';
import { I18nProvider } from '@/test/i18n-test-utils';

const f = (annotation: 'new' | 'missing' | 'shared') => ({
  file: 'src/x.ts', line: 12, message: 'Missing branch', severity: 'warning' as const,
  category: 'test', annotation,
});

describe('FindingRow', () => {
  it('renders file:line + message', () => {
    render(<I18nProvider><FindingRow finding={f('shared')} /></I18nProvider>);
    expect(screen.getByText('src/x.ts:12')).toBeInTheDocument();
    expect(screen.getByText(/Missing branch/)).toBeInTheDocument();
  });

  it('shows NEW badge when annotation is new', () => {
    render(<I18nProvider><FindingRow finding={f('new')} /></I18nProvider>);
    expect(screen.getByText('NEW')).toBeInTheDocument();
  });

  it('shows MISSING badge when annotation is missing', () => {
    render(<I18nProvider><FindingRow finding={f('missing')} /></I18nProvider>);
    expect(screen.getByText('MISSING')).toBeInTheDocument();
  });

  it('shows no badge when shared', () => {
    render(<I18nProvider><FindingRow finding={f('shared')} /></I18nProvider>);
    expect(screen.queryByText('NEW')).toBeNull();
    expect(screen.queryByText('MISSING')).toBeNull();
  });
});
```

(Use the existing project i18n test helper. If none exists, inline `NextIntlClientProvider` with the messages — copy from `LinkedSkillRow.test.tsx` (Spec B).)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd client && pnpm exec vitest run FindingRow.test
```

Expected: FAIL.

- [ ] **Step 3: Implement FindingRow.tsx + styles.ts + index.ts**

`FindingRow.tsx`:

```tsx
'use client';
import { useTranslations } from 'next-intl';
import { row, badge, dot, fileLine, msg } from './styles';
import type { AnnotatedFinding } from '../EvalResultsSplit/diffFindings';

const SEVERITY_COLOR: Record<string, string> = {
  error: '#e11d48',
  warning: '#f59e0b',
  info: '#3b82f6',
};

export function FindingRow({ finding }: { finding: AnnotatedFinding }) {
  const t = useTranslations('agents.eval.badge');
  return (
    <div css={row}>
      <span css={dot} style={{ background: SEVERITY_COLOR[finding.severity] ?? '#9ca3af' }} />
      <span css={fileLine}>{finding.file}:{finding.line}</span>
      <span css={msg}>{finding.message}</span>
      {finding.annotation === 'new' && <span css={[badge, { color: '#16a34a' }]}>{t('new')}</span>}
      {finding.annotation === 'missing' && <span css={[badge, { color: '#dc2626' }]}>{t('missing')}</span>}
    </div>
  );
}
```

`styles.ts`:

```ts
import { css } from '@emotion/react';

export const row = css`display: grid; grid-template-columns: 12px 1fr auto; gap: 8px; align-items: center; padding: 8px 0;`;
export const dot = css`width: 8px; height: 8px; border-radius: 50%;`;
export const fileLine = css`font-family: var(--font-mono); font-size: 12px; color: var(--text-muted);`;
export const msg = css`font-size: 13px;`;
export const badge = css`font-size: 10px; font-weight: 700; letter-spacing: 0.5px; padding: 2px 6px; border-radius: 4px; border: 1px solid currentColor;`;
```

(Match the existing project's CSS-in-JS conventions — verify with `LinkedSkillRow/styles.ts` from Spec B and adapt.)

`index.ts`:

```ts
export { FindingRow } from './FindingRow.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd client && pnpm exec vitest run FindingRow.test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/agents/\[id\]/_components/AgentEditor/_components/SkillsTab/_components/SkillsEvalModal/_components/FindingRow/
git commit -m 'feat(client): FindingRow component (severity dot + file:line + NEW/MISSING badge)'
```

---

## Task 12 [C5]: `EvalResultsSplit` component

**Files:**
- Create: `.../_components/EvalResultsSplit/EvalResultsSplit.tsx`
- Create: `.../EvalResultsSplit.test.tsx`
- Create: `.../styles.ts`
- Create: `.../index.ts`

**Interfaces:**
- Consumes: `diffFindings` (Task 10), `FindingRow` (Task 11), `SkillsEvalResult` (contracts).
- Produces: `EvalResultsSplit({ result }: { result: SkillsEvalResult }): JSX.Element` — two-column layout. Each column header shows column label, finding count, tokens, cost. Empty column shows "No findings".

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { EvalResultsSplit } from './EvalResultsSplit.js';
import { I18nProvider } from '@/test/i18n-test-utils';

const mk = (findings: any[], tokensIn = 100, tokensOut = 200, costUsd: number | null = 0.0012) => ({
  findings, grounding: '1/1 passed', tokensIn, tokensOut, costUsd,
});

const result = {
  fixture: { id: 'fx1', title: 'Fixture 1' },
  with_skills: mk([
    { file: 'a.ts', line: 1, message: 'shared one', severity: 'warning', category: 'x' },
    { file: 'b.ts', line: 2, message: 'unique to with', severity: 'warning', category: 'x' },
  ]),
  without_skills: mk([
    { file: 'a.ts', line: 1, message: 'shared one', severity: 'warning', category: 'x' },
  ]),
};

describe('EvalResultsSplit', () => {
  it('renders both columns with counts', () => {
    render(<I18nProvider><EvalResultsSplit result={result as any} /></I18nProvider>);
    const withCol = screen.getByTestId('with-column');
    const withoutCol = screen.getByTestId('without-column');
    expect(within(withCol).getByText(/2/)).toBeInTheDocument();
    expect(within(withoutCol).getByText(/1/)).toBeInTheDocument();
  });

  it('renders NEW badge on with column for unique findings', () => {
    render(<I18nProvider><EvalResultsSplit result={result as any} /></I18nProvider>);
    const withCol = screen.getByTestId('with-column');
    expect(within(withCol).getByText('NEW')).toBeInTheDocument();
  });

  it('renders empty state when a column has no findings', () => {
    const empty = { ...result, with_skills: mk([]) };
    render(<I18nProvider><EvalResultsSplit result={empty as any} /></I18nProvider>);
    expect(screen.getByText('No findings')).toBeInTheDocument();
  });

  it('renders tokens and cost per column', () => {
    render(<I18nProvider><EvalResultsSplit result={result as any} /></I18nProvider>);
    // 100 + 200 = 300 tokens per column
    expect(screen.getAllByText(/300 tokens/i).length).toBe(2);
    expect(screen.getAllByText(/\$0\.0012/i).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd client && pnpm exec vitest run EvalResultsSplit.test
```

Expected: FAIL.

- [ ] **Step 3: Implement EvalResultsSplit.tsx + styles.ts + index.ts**

`EvalResultsSplit.tsx`:

```tsx
'use client';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import type { SkillsEvalResult } from '@/vendor/shared/contracts/knowledge';
import { diffFindings, type AnnotatedFinding } from './diffFindings.js';
import { FindingRow } from '../FindingRow';
import { split, column, header, body, empty, meta } from './styles';

export function EvalResultsSplit({ result }: { result: SkillsEvalResult }) {
  const t = useTranslations('agents.eval');
  const { withAnnotated, withoutAnnotated } = useMemo(
    () => diffFindings(result.with_skills.findings, result.without_skills.findings),
    [result],
  );
  return (
    <div css={split}>
      <Column
        testId="with-column"
        title={t('withColumn')}
        findings={withAnnotated}
        tokens={result.with_skills.tokensIn + result.with_skills.tokensOut}
        costUsd={result.with_skills.costUsd}
        emptyLabel={t('noFindings')}
        tokensLabel={(n: number) => t('tokens', { n })}
        costLabel={(c: string) => t('cost', { cost: c })}
      />
      <Column
        testId="without-column"
        title={t('withoutColumn')}
        findings={withoutAnnotated}
        tokens={result.without_skills.tokensIn + result.without_skills.tokensOut}
        costUsd={result.without_skills.costUsd}
        emptyLabel={t('noFindings')}
        tokensLabel={(n: number) => t('tokens', { n })}
        costLabel={(c: string) => t('cost', { cost: c })}
      />
    </div>
  );
}

function Column(props: {
  testId: string;
  title: string;
  findings: AnnotatedFinding[];
  tokens: number;
  costUsd: number | null;
  emptyLabel: string;
  tokensLabel: (n: number) => string;
  costLabel: (c: string) => string;
}) {
  return (
    <div css={column} data-testid={props.testId}>
      <div css={header}>
        <h3>{props.title} <small>({props.findings.length})</small></h3>
        <div css={meta}>
          <span>{props.tokensLabel(props.tokens)}</span>
          {props.costUsd != null && <span>{props.costLabel(props.costUsd.toFixed(4))}</span>}
        </div>
      </div>
      <div css={body}>
        {props.findings.length === 0 ? (
          <p css={empty}>{props.emptyLabel}</p>
        ) : (
          props.findings.map((f, i) => <FindingRow key={`${f.file}:${f.line}:${i}`} finding={f} />)
        )}
      </div>
    </div>
  );
}
```

`styles.ts`:

```ts
import { css } from '@emotion/react';

export const split = css`display: grid; grid-template-columns: 1fr 1fr; gap: 16px;`;
export const column = css`border: 1px solid var(--border-subtle); border-radius: 8px; padding: 12px; min-height: 200px;`;
export const header = css`border-bottom: 1px solid var(--border-subtle); padding-bottom: 8px; margin-bottom: 8px;`;
export const meta = css`display: flex; gap: 12px; font-size: 11px; color: var(--text-muted); margin-top: 4px;`;
export const body = css`display: flex; flex-direction: column;`;
export const empty = css`color: var(--text-muted); font-size: 13px; padding: 16px 0;`;
```

`index.ts`:

```ts
export { EvalResultsSplit } from './EvalResultsSplit.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd client && pnpm exec vitest run EvalResultsSplit.test
```

Expected: PASS on all 4 cases.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/agents/\[id\]/_components/AgentEditor/_components/SkillsTab/_components/SkillsEvalModal/_components/EvalResultsSplit/
git commit -m 'feat(client): EvalResultsSplit side-by-side findings diff'
```

---

## Task 13 [C6]: `FixturePicker` component

**Files:**
- Create: `.../FixturePicker/FixturePicker.tsx`, `.test.tsx`, `styles.ts`, `index.ts`

**Interfaces:**
- Consumes: `useEvalFixtures` (Task 8).
- Produces: `FixturePicker({ value, onChange }: { value: string | null; onChange: (id: string) => void })`. Renders a `<select>` of fixtures by id+title. While loading, disabled placeholder. Empty list → static "No fixtures available." message.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FixturePicker } from './FixturePicker.js';
import { I18nProvider, QueryProvider } from '@/test/i18n-test-utils';
import * as agentsHooks from '@/lib/hooks/agents';

vi.mock('@/lib/hooks/agents');

describe('FixturePicker', () => {
  it('renders fixtures and fires onChange', async () => {
    vi.mocked(agentsHooks.useEvalFixtures).mockReturnValue({
      data: [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }],
      isLoading: false,
    } as any);
    const onChange = vi.fn();
    render(
      <QueryProvider><I18nProvider>
        <FixturePicker value="a" onChange={onChange} />
      </I18nProvider></QueryProvider>,
    );
    await userEvent.selectOptions(screen.getByRole('combobox'), 'b');
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('shows empty state when no fixtures', () => {
    vi.mocked(agentsHooks.useEvalFixtures).mockReturnValue({ data: [], isLoading: false } as any);
    render(<QueryProvider><I18nProvider><FixturePicker value={null} onChange={() => {}} /></I18nProvider></QueryProvider>);
    expect(screen.getByText('No fixtures available.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd client && pnpm exec vitest run FixturePicker.test
```

Expected: FAIL.

- [ ] **Step 3: Implement FixturePicker.tsx + styles.ts + index.ts**

```tsx
'use client';
import { useTranslations } from 'next-intl';
import { useEvalFixtures } from '@/lib/hooks/agents';
import { wrap, label, select, emptyHint } from './styles';

export function FixturePicker({ value, onChange }: { value: string | null; onChange: (id: string) => void }) {
  const t = useTranslations('agents.eval');
  const { data: fixtures = [], isLoading } = useEvalFixtures();

  if (!isLoading && fixtures.length === 0) {
    return <p css={emptyHint}>{t('noFixtures')}</p>;
  }

  return (
    <div css={wrap}>
      <label css={label}>{t('fixtureLabel')}</label>
      <select
        css={select}
        disabled={isLoading}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      >
        {fixtures.map((f) => (
          <option key={f.id} value={f.id}>{f.title}</option>
        ))}
      </select>
    </div>
  );
}
```

`styles.ts`:

```ts
import { css } from '@emotion/react';
export const wrap = css`display: flex; flex-direction: column; gap: 4px;`;
export const label = css`font-size: 12px; color: var(--text-muted);`;
export const select = css`padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border-subtle);`;
export const emptyHint = css`color: var(--text-muted); font-style: italic;`;
```

`index.ts`:

```ts
export { FixturePicker } from './FixturePicker.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd client && pnpm exec vitest run FixturePicker.test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/agents/\[id\]/_components/AgentEditor/_components/SkillsTab/_components/SkillsEvalModal/_components/FixturePicker/
git commit -m 'feat(client): FixturePicker dropdown for skills eval modal'
```

---

## Task 14 [C7]: `SkillsEvalModal` — orchestrator

**Files:**
- Create: `.../SkillsEvalModal/SkillsEvalModal.tsx`, `.test.tsx`, `styles.ts`, `index.ts`

**Interfaces:**
- Consumes: `useSkillsEval` (Task 8); `FixturePicker` (Task 13); `EvalResultsSplit` (Task 12).
- Produces: `SkillsEvalModal({ agentId, open, onClose })`. Internal state machine: `picker → running → results → error`. Picker shows `FixturePicker` + Run button. Running shows spinner + cancel button. Results shows `EvalResultsSplit` + Close. Error shows message + Retry.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SkillsEvalModal } from './SkillsEvalModal.js';
import { I18nProvider, QueryProvider } from '@/test/i18n-test-utils';
import * as agentsHooks from '@/lib/hooks/agents';

vi.mock('@/lib/hooks/agents');

const result = {
  fixture: { id: 'a', title: 'Alpha' },
  with_skills: { findings: [], grounding: '0/0', tokensIn: 1, tokensOut: 1, costUsd: 0 },
  without_skills: { findings: [], grounding: '0/0', tokensIn: 1, tokensOut: 1, costUsd: 0 },
};

describe('SkillsEvalModal', () => {
  beforeEach(() => {
    vi.mocked(agentsHooks.useEvalFixtures).mockReturnValue({ data: [{ id: 'a', title: 'Alpha' }], isLoading: false } as any);
  });

  it('renders picker state initially', () => {
    vi.mocked(agentsHooks.useSkillsEval).mockReturnValue({
      mutate: vi.fn(), isPending: false, isError: false, data: undefined,
    } as any);
    render(<QueryProvider><I18nProvider><SkillsEvalModal agentId="x" open onClose={() => {}} /></I18nProvider></QueryProvider>);
    expect(screen.getByRole('button', { name: /run comparison/i })).toBeInTheDocument();
  });

  it('Run fires the mutation with the selected fixture', async () => {
    const mutate = vi.fn();
    vi.mocked(agentsHooks.useSkillsEval).mockReturnValue({ mutate, isPending: false, isError: false, data: undefined } as any);
    render(<QueryProvider><I18nProvider><SkillsEvalModal agentId="x" open onClose={() => {}} /></I18nProvider></QueryProvider>);
    await userEvent.click(screen.getByRole('button', { name: /run comparison/i }));
    expect(mutate).toHaveBeenCalledWith({ fixture_id: 'a' });
  });

  it('shows running state when isPending', () => {
    vi.mocked(agentsHooks.useSkillsEval).mockReturnValue({ mutate: vi.fn(), isPending: true, isError: false, data: undefined } as any);
    render(<QueryProvider><I18nProvider><SkillsEvalModal agentId="x" open onClose={() => {}} /></I18nProvider></QueryProvider>);
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  it('shows results state when data is returned', () => {
    vi.mocked(agentsHooks.useSkillsEval).mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, data: result } as any);
    render(<QueryProvider><I18nProvider><SkillsEvalModal agentId="x" open onClose={() => {}} /></I18nProvider></QueryProvider>);
    expect(screen.getByTestId('with-column')).toBeInTheDocument();
    expect(screen.getByTestId('without-column')).toBeInTheDocument();
  });

  it('shows error + Retry when isError', async () => {
    const mutate = vi.fn();
    vi.mocked(agentsHooks.useSkillsEval).mockReturnValue({ mutate, isPending: false, isError: true, data: undefined } as any);
    render(<QueryProvider><I18nProvider><SkillsEvalModal agentId="x" open onClose={() => {}} /></I18nProvider></QueryProvider>);
    expect(screen.getByText(/could not run/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(mutate).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd client && pnpm exec vitest run SkillsEvalModal.test
```

Expected: FAIL.

- [ ] **Step 3: Implement SkillsEvalModal.tsx + styles.ts + index.ts**

```tsx
'use client';
import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useEvalFixtures, useSkillsEval } from '@/lib/hooks/agents';
import { FixturePicker } from './_components/FixturePicker';
import { EvalResultsSplit } from './_components/EvalResultsSplit';
import { overlay, dialog, header, body, footer, runningBox, spinner, errorBox } from './styles';

export function SkillsEvalModal({ agentId, open, onClose }: { agentId: string; open: boolean; onClose: () => void }) {
  const t = useTranslations('agents.eval');
  const { data: fixtures = [] } = useEvalFixtures();
  const [fixtureId, setFixtureId] = useState<string | null>(null);
  const { mutate, isPending, isError, data, reset } = useSkillsEval(agentId);

  useEffect(() => {
    if (fixtureId == null && fixtures[0]) setFixtureId(fixtures[0].id);
  }, [fixtures, fixtureId]);

  if (!open) return null;

  const run = () => {
    if (fixtureId) mutate({ fixture_id: fixtureId });
  };

  const close = () => {
    reset();
    onClose();
  };

  return (
    <div css={overlay} role="dialog" aria-modal>
      <div css={dialog}>
        <header css={header}>
          <h2>{t('title')}</h2>
          <p>{t('subtitle')}</p>
        </header>
        <section css={body}>
          {isPending ? (
            <div css={runningBox}>
              <span css={spinner} aria-hidden /> {t('running')}
            </div>
          ) : isError ? (
            <div css={errorBox}>
              <p>{t('error')}</p>
              <button onClick={run}>{t('retry')}</button>
            </div>
          ) : data ? (
            <EvalResultsSplit result={data} />
          ) : (
            <FixturePicker value={fixtureId} onChange={setFixtureId} />
          )}
        </section>
        <footer css={footer}>
          {data || isError ? (
            <button onClick={close}>{t('close')}</button>
          ) : isPending ? (
            <button disabled>{t('running')}</button>
          ) : (
            <>
              <button onClick={close}>{t('cancel')}</button>
              <button onClick={run} disabled={!fixtureId}>{t('run')}</button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
```

`styles.ts`:

```ts
import { css, keyframes } from '@emotion/react';

const spin = keyframes`from { transform: rotate(0); } to { transform: rotate(360deg); }`;

export const overlay = css`position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: grid; place-items: center; z-index: 1000;`;
export const dialog = css`background: var(--bg-card); border-radius: 12px; padding: 20px; width: min(900px, 90vw); max-height: 90vh; overflow: auto;`;
export const header = css`margin-bottom: 16px;`;
export const body = css`min-height: 200px;`;
export const footer = css`display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px;`;
export const runningBox = css`display: flex; align-items: center; gap: 12px; padding: 24px; color: var(--text-muted);`;
export const spinner = css`width: 16px; height: 16px; border: 2px solid var(--border-subtle); border-top-color: var(--accent); border-radius: 50%; animation: ${spin} 1s linear infinite;`;
export const errorBox = css`padding: 16px; color: var(--text-danger); display: flex; flex-direction: column; gap: 12px;`;
```

`index.ts`:

```ts
export { SkillsEvalModal } from './SkillsEvalModal.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd client && pnpm exec vitest run SkillsEvalModal.test
```

Expected: PASS on all 5 cases.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/agents/\[id\]/_components/AgentEditor/_components/SkillsTab/_components/SkillsEvalModal/SkillsEvalModal.tsx \
        client/src/app/agents/\[id\]/_components/AgentEditor/_components/SkillsTab/_components/SkillsEvalModal/SkillsEvalModal.test.tsx \
        client/src/app/agents/\[id\]/_components/AgentEditor/_components/SkillsTab/_components/SkillsEvalModal/styles.ts \
        client/src/app/agents/\[id\]/_components/AgentEditor/_components/SkillsTab/_components/SkillsEvalModal/index.ts
git commit -m 'feat(client): SkillsEvalModal state machine (picker/running/results/error)'
```

---

## Task 15 [C8]: Wire button into `SkillsTab`

**Files:**
- Modify: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.tsx`
- Modify: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.test.tsx`

**Interfaces:**
- Consumes: `SkillsEvalModal` (Task 14); the existing `useAgentSkills` from Spec B (already returns `AgentSkillLink[]` with `enabled`).
- Produces: a button rendered alongside the existing order hint in `SkillsTab`. Disabled when no link is enabled; tooltip `skills.evalEmpty`. Click opens the modal.

- [ ] **Step 1: Write the failing test (extend `SkillsTab.test.tsx`)**

Append new cases:

```tsx
it('renders Compare button enabled when ≥1 link is enabled', () => {
  vi.mocked(agentsHooks.useAgentSkills).mockReturnValue({
    data: [{ skill_id: 'sk1', enabled: true, order: 0, agent_id: 'a' }],
    isLoading: false,
  } as any);
  renderTab();
  expect(screen.getByRole('button', { name: /compare with vs without skills/i })).toBeEnabled();
});

it('disables Compare button when no enabled links', () => {
  vi.mocked(agentsHooks.useAgentSkills).mockReturnValue({
    data: [{ skill_id: 'sk1', enabled: false, order: 0, agent_id: 'a' }],
    isLoading: false,
  } as any);
  renderTab();
  expect(screen.getByRole('button', { name: /compare with vs without skills/i })).toBeDisabled();
});

it('opens the modal on click', async () => {
  vi.mocked(agentsHooks.useAgentSkills).mockReturnValue({
    data: [{ skill_id: 'sk1', enabled: true, order: 0, agent_id: 'a' }],
    isLoading: false,
  } as any);
  vi.mocked(agentsHooks.useEvalFixtures).mockReturnValue({ data: [{ id: 'a', title: 'Alpha' }], isLoading: false } as any);
  vi.mocked(agentsHooks.useSkillsEval).mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, data: undefined } as any);
  renderTab();
  await userEvent.click(screen.getByRole('button', { name: /compare with vs without skills/i }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd client && pnpm exec vitest run SkillsTab.test
```

Expected: 3 NEW cases FAIL.

- [ ] **Step 3: Add the button + modal mount in SkillsTab.tsx**

Inside `SkillsTab.tsx`, locate where the order hint is rendered (near the top of the linked-skills section). Add the button + modal state:

```tsx
const [evalOpen, setEvalOpen] = useState(false);
const hasEnabledLink = (links ?? []).some((l) => l.enabled);

// ... in the header area, alongside the order hint:
<button
  type="button"
  onClick={() => setEvalOpen(true)}
  disabled={!hasEnabledLink}
  title={!hasEnabledLink ? t('skills.evalEmpty') : undefined}
>
  {t('skills.evalButton')}
</button>

// ... at the bottom of the component's JSX, before the closing tag:
<SkillsEvalModal agentId={agent.id} open={evalOpen} onClose={() => setEvalOpen(false)} />
```

Add imports: `import { useState } from 'react';` and `import { SkillsEvalModal } from './_components/SkillsEvalModal';`.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd client && pnpm exec vitest run SkillsTab.test
```

Expected: ALL pass (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add client/src/app/agents/\[id\]/_components/AgentEditor/_components/SkillsTab/SkillsTab.tsx \
        client/src/app/agents/\[id\]/_components/AgentEditor/_components/SkillsTab/SkillsTab.test.tsx
git commit -m 'feat(client): wire Compare-with-vs-without-skills button into SkillsTab'
```

---

## Task 16 [V1]: Manual verification + INSIGHTS append

**Files:**
- Optional: `server/INSIGHTS.md` and/or `client/INSIGHTS.md` and/or `INSIGHTS.md` — append a dated entry if you hit anything non-obvious.

- [ ] **Step 1: Full server typecheck + test suite**

```bash
cd server && pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 2: Full client typecheck + test suite**

```bash
cd client && pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 3: Manual smoke**

```bash
# In one terminal:
./scripts/dev.sh

# In another:
cd server && pnpm db:seed --with-skills
```

- Open the studio in a browser.
- Navigate to Agents → Test Quality Reviewer → Skills tab.
- Verify both skills appear, both enabled.
- Click "Compare with vs without skills".
- Pick the `test-only-happy-path` fixture, click Run.
- Wait ~6–20s.
- Verify: both columns render, "with" column flags a missing-branch / edge-case concept that the "without" column doesn't (NEW badge). The control experiment criterion is met when at least one such NEW finding lands.

Note any surprises in INSIGHTS.md (per global CLAUDE.md engineering-insights loop). For trivial smoke success, no entry needed.

- [ ] **Step 4: Run /pr-self-review before declaring ready**

Per project CLAUDE.md ("Pre-ready architectural check"), if the diff touches client/ or server/ — which it does — run the soft gate:

```
/pr-self-review
```

Address MUST findings before claiming ready. SHOULD findings: surface in the final summary.

- [ ] **Step 5: Final commit (if anything from steps 3-4 required tweaks)**

If smoke uncovered anything, fix + commit. Otherwise skip.

```bash
git status   # verify clean
```

---

## Acceptance criteria (from spec, mapped to tasks)

| Spec acceptance | Covered by |
|---|---|
| `pnpm db:seed --with-skills` produces a Test Quality Reviewer agent + two linked skills | Task 6 |
| Skills tab shows both skills, both enabled | Existing Spec B + Task 6 seed |
| "Compare with vs without skills" button is visible and enabled | Task 15 |
| Clicking opens the modal, lets the user pick a fixture, Run produces two finding sets within ~3-10s each | Tasks 13 + 14 + 7 |
| `test-only-happy-path.json` with skills produces a missing-branch finding; without skills produces fewer/none on that concept | Task 16 (manual smoke) |
| DB unchanged before and after a comparison run | Task 7 test (asserts) |
| User can re-run the same comparison and get categorically the same findings | Reviewer-core determinism + Task 7 acceptance |

---

## Self-review (post-write check)

**Spec coverage:** every spec section is referenced — fixtures (Task 4), seed (Task 6), endpoints (Task 7), client tree (Tasks 8–15), test plan (server tests in Tasks 1, 4, 6, 7; client tests in Tasks 10, 11, 12, 13, 14, 15), determinism caveat (Task 16). Three deferred items are listed in "Deviations from spec" with reasons.

**Placeholder scan:** no TBD / TODO / "similar to" left in the plan body. The one `throw new Error('TODO: copy seed pattern...')` in Task 1's test is intentional — the engineer is told exactly which file to copy the helper from.

**Type consistency:** `loadEnabledSkillBodies` (Task 1, service method) is the name used in Tasks 2 + 5. `evaluateSkillsAB` (Task 5) matches Task 7. `SkillsEvalResult` shape (Task 3) is what the route returns (Task 7) and what the client parses (Task 8) and what `EvalResultsSplit` consumes (Task 12). `AnnotatedFinding.annotation` enum (Task 10) is `'new' | 'missing' | 'shared'`, used unchanged in Tasks 11 + 12.

**Order of operations:** S-tasks land before C-tasks; production wiring (Task 2) lands before the eval endpoint (Tasks 5+7) so the production code path is always green.

---

## References

- Spec: [docs/superpowers/specs/2026-06-23-skills-d-test-quality-and-eval-design.md](../specs/2026-06-23-skills-d-test-quality-and-eval-design.md)
- Spec A: [docs/superpowers/specs/2026-06-23-skills-ui-list-editor-design.md](../specs/2026-06-23-skills-ui-list-editor-design.md)
- Spec B: [docs/superpowers/specs/2026-06-23-skills-b-agent-editor-tab-design.md](../specs/2026-06-23-skills-b-agent-editor-tab-design.md)
- Spec B plan (sibling): [docs/superpowers/plans/2026-06-23-skills-b-agent-editor-tab.md](2026-06-23-skills-b-agent-editor-tab.md)
- Server INSIGHTS (vendored-contracts dual-write rule, `linkSkill` upsert subtlety): [server/INSIGHTS.md](../../../server/INSIGHTS.md)
- Reviewer-core entry: [reviewer-core/src/review/run.ts](../../../reviewer-core/src/review/run.ts)
- Run executor (production wiring target): [server/src/modules/reviews/run-executor.ts](../../../server/src/modules/reviews/run-executor.ts)
- Unified-diff parser (used by fixture loader): [server/src/adapters/git/diff-parser.ts](../../../server/src/adapters/git/diff-parser.ts)

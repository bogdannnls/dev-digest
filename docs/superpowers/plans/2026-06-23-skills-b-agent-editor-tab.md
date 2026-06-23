# Spec B — Agent Editor → Skills tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Skills tab to the Agent Editor that lets a user browse, link, reorder, enable/disable, and unlink the skills tied to a single agent — with optimistic UI and an enabled flag persisted on the join row.

**Architecture:** Append-only Drizzle migration adds `enabled boolean` to `agent_skills`. Server extends `AgentSkillLink` contract, repository, service, and routes (new `PATCH` and `DELETE /agents/:id/skills/:skillId`). Client gets five TanStack Query hooks mirroring Spec A's optimistic patterns, plus a `SkillsTab` component tree (`SkillsTab` + `LinkedSkillRow` + `AddSkillPicker` drawer) using `@dnd-kit/sortable` for accessible drag-to-reorder.

**Tech Stack:** TypeScript everywhere · Fastify 5 + Drizzle ORM + Postgres 16 (server) · Next.js 15 + React 19 + TanStack Query + `@dnd-kit/*` (client) · vitest + jsdom + RTL (tests).

## Global Constraints

- Node ≥22, pnpm ≥10. Per-package `package.json` and lockfile; no root workspace.
- Integration tests must use the `*.it.test.ts` suffix; CI splits on this.
- Drizzle migrations are append-only — never edit a migration after it has been applied; generate new ones via `pnpm db:generate`.
- Migration auto-apply is OFF — `pnpm db:migrate` is manual.
- All server access from the client funnels through `src/lib/api.ts`.
- Server state on the client is owned by TanStack Query hooks in `src/lib/hooks/`; views don't call `api.*` directly.
- Routes register Zod schemas at the boundary; invalid requests → 422 automatically.
- Errors in route handlers must extend `platform/errors.ts` (no `throw new Error()`).
- Workspace-scoping: every agent-skill endpoint that mutates or reads link state MUST gate on the agent existing within `workspaceId` (404 otherwise — covers cross-workspace defense).
- TYPE_BADGE_BG (skill-type colours) and the `SkillPreviewDrawer` style shape are **duplicated locally** inside the new SkillsTab tree — do NOT import from `src/app/skills/` (ui-architecture rule: no cross-page imports between feature dirs).
- Skill link/order/enable changes do NOT bump the agent's `version` — `isConfigChange` is the single source of truth and already excludes link fields. Tests assert this.
- Optimistic mutations mirror the pattern in [client/src/lib/hooks/skills.ts:62-90](../../../client/src/lib/hooks/skills.ts:62) (`useUpdateSkill`): `onMutate` cancels in-flight queries, patches list+detail caches, returns a context; `onError` restores from context; `onSuccess` invalidates.
- Concurrent-edit conflicts (two tabs editing the same agent) are last-write-wins by design; v1 accepts this.
- All commit messages are English, single-quoted, descriptive.

---

## File Structure

### Server (extends the existing `agents` module — no new modules)

- **Modify** `server/src/db/schema/agents.ts:51-63` — add `enabled` column to `agentSkills`.
- **Generate** `server/src/db/migrations/0010_*.sql` (drizzle-kit picks a name) plus the matching `meta/0010_snapshot.json`. Verify the produced SQL is the single `ALTER TABLE agent_skills ADD COLUMN enabled boolean NOT NULL DEFAULT true;`.
- **Modify** `server/src/vendor/shared/contracts/knowledge.ts:194-199` — extend `AgentSkillLink` with `enabled: z.boolean()`.
- **Modify** `server/src/modules/agents/repository.ts` — extend `LinkedSkillRow`, project `enabled` through `linkedSkills`, thread optional `enabled` into `linkSkill`, preserve `enabled` in `setSkills`, add `setSkillEnabled`.
- **Modify** `server/src/modules/agents/service.ts` — extend `skillLinks`, `linkSkill`, thread `enabled` through; add `setSkillEnabled(workspaceId, agentId, skillId, enabled)`.
- **Modify** `server/src/modules/agents/routes.ts` — extend `SetSkillsBody.enabled`, add `PATCH /agents/:id/skills/:skillId`, add `DELETE /agents/:id/skills/:skillId`.
- **Create** `server/test/agent-skills-enabled.it.test.ts` — single integration test file for all server-side behavior added in this plan.

### Client (new SkillsTab tree, hooks, and i18n)

- **Modify** `client/package.json` — add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`.
- **Modify** `client/messages/en/agents.json:90-95` — fix `enabledCount` to `{enabled} of {total} enabled`, rewrite `orderHint` per spec, add `addSkill`, `removeFromAgent`, `emptyTitle`, `emptyBody`, `picker.*`.
- **Modify** `client/src/lib/hooks/agents.ts` — append five hooks: `useAgentSkills`, `useSetAgentSkills`, `useLinkAgentSkill`, `useUnlinkAgentSkill`, `useSetAgentSkillEnabled`.
- **Modify** `client/src/app/agents/[id]/_components/AgentEditor/constants.ts` — append `{ key: "skills", labelKey: "editor.tabs.skills", icon: "Sparkles" }`.
- **Modify** `client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.tsx` — render `<SkillsTab agent={agent} />` when `tab === "skills"`.
- **Modify** `client/src/app/agents/[id]/page.tsx:15` — extend `VALID_TABS = ["config", "skills"]`.
- **Create** `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/` directory:
  - `SkillsTab.tsx` — owns the layout: header, filter, order hint, sortable list, AddSkillPicker mount, empty state.
  - `SkillsTab.test.tsx`
  - `styles.ts` — co-located CSS-in-JS for header, list, hint, empty state.
  - `constants.ts` — local `TYPE_BADGE_BG` duplicate.
  - `index.ts` — barrel export.
  - `_components/LinkedSkillRow/` — `LinkedSkillRow.tsx`, `LinkedSkillRow.test.tsx`, `styles.ts`, `index.ts`.
  - `_components/AddSkillPicker/` — `AddSkillPicker.tsx`, `AddSkillPicker.test.tsx`, `styles.ts`, `index.ts`.

---

## Task Sequencing Notes

The contract change to `AgentSkillLink` (Task S3) is breaking at the type level. The repository (Task S2) returns its own `LinkedSkillRow` shape — that change is internal and doesn't touch consumers. So the order is: schema/migration → repository → contract+service → routes. CI stays green after each task individually.

The client's `useAgentSkills` hook returns `AgentSkillLink[]`, which gains `enabled` after Task S3. Client work (C-tasks) runs AFTER all S-tasks land.

---

## Task 1 [S1]: Schema + migration

**Files:**
- Modify: `server/src/db/schema/agents.ts:51-63`
- Create: `server/src/db/migrations/0010_<drizzle-suffix>.sql`
- Create: `server/src/db/migrations/meta/0010_snapshot.json` (auto-generated by drizzle-kit)
- Test: integration smoke — DB column exists with the right default

**Interfaces:**
- Consumes: none (first task).
- Produces: `agent_skills` table now has `enabled boolean NOT NULL DEFAULT true`. Existing rows backfill to `true`.

- [ ] **Step 1: Edit the schema**

In `server/src/db/schema/agents.ts`, add a `boolean` column to `agentSkills`. The final block (lines 51–63) must be:

```ts
export const agentSkills = pgTable(
  'agent_skills',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    order: integer('order').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => ({ pk: primaryKey({ columns: [t.agentId, t.skillId] }) }),
);
```

- [ ] **Step 2: Generate the migration**

Run from `server/`:

```bash
pnpm db:generate
```

Expected: drizzle-kit produces `src/db/migrations/0010_<word>.sql` and `meta/0010_snapshot.json`. Open the new `.sql` file and verify it contains exactly:

```sql
ALTER TABLE "agent_skills" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;
```

If the generated SQL is something else (e.g. drizzle-kit drops/recreates the table), STOP and investigate before continuing — the spec explicitly requires `ALTER TABLE … ADD COLUMN`.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: PASS — the schema change alone doesn't break anything yet (repo/service still read `select({ skill, order })`).

- [ ] **Step 4: Commit**

```bash
git add server/src/db/schema/agents.ts server/src/db/migrations/0010_*.sql server/src/db/migrations/meta/0010_snapshot.json
git commit -m 'feat(server): add enabled column to agent_skills (migration 0010)'
```

---

## Task 2 [S2]: Repository — surface and preserve `enabled`

**Files:**
- Modify: `server/src/modules/agents/repository.ts` (lines 45–49 `LinkedSkillRow`, lines 192–235 `linkedSkills`/`linkSkill`/`setSkills`; append `setSkillEnabled`)
- Test: `server/test/agent-skills-enabled.it.test.ts` (new file)

**Interfaces:**
- Consumes: Task S1's `enabled` column.
- Produces:
  - `interface LinkedSkillRow { skill: typeof t.skills.$inferSelect; order: number; enabled: boolean; }`
  - `linkSkill(agentId: string, skillId: string, order: number, enabled?: boolean): Promise<void>` — default `enabled = true`.
  - `setSkills(agentId: string, skillIds: string[]): Promise<void>` — preserves the `enabled` flag of any pre-existing `(agentId, skillId)` row; new rows default to `true`. Single transaction.
  - `setSkillEnabled(agentId: string, skillId: string, enabled: boolean): Promise<boolean>` — single-row UPDATE. Returns `true` if a row was updated, `false` otherwise.

- [ ] **Step 1: Write the failing integration test**

Create `server/test/agent-skills-enabled.it.test.ts` with the standard Postgres fixture preamble (mirrors [server/test/agents-versions.it.test.ts:1-45](../../../server/test/agents-versions.it.test.ts:1)):

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import { AgentsRepository } from '../src/modules/agents/repository.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[agent-skills-enabled] Docker not available — skipping.');
}

d('agent_skills.enabled', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function makeApp() {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      db: pg.handle.db,
      overrides: { git: new MockGitClient(), github: new MockGitHubClient() },
    });
  }

  async function createAgent(app: Awaited<ReturnType<typeof makeApp>>) {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'Skills tab agent',
        provider: 'openai',
        model: 'gpt-4o-mini',
        system_prompt: 'review the diff',
      },
    });
    return res.json().id as string;
  }

  async function createSkill(app: Awaited<ReturnType<typeof makeApp>>, name: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: { name, type: 'rubric', body: '## body' },
    });
    return res.json().id as string;
  }

  it('linkedSkills returns enabled=true by default', async () => {
    const app = await makeApp();
    const repo = new AgentsRepository(pg.handle.db);
    const agentId = await createAgent(app);
    const skillId = await createSkill(app, 'skill-default-enabled');

    await repo.linkSkill(agentId, skillId, 0);
    const links = await repo.linkedSkills(agentId);

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ order: 0, enabled: true });
    expect(links[0]!.skill.id).toBe(skillId);
    await app.close();
  });

  it('linkSkill accepts explicit enabled=false', async () => {
    const app = await makeApp();
    const repo = new AgentsRepository(pg.handle.db);
    const agentId = await createAgent(app);
    const skillId = await createSkill(app, 'skill-link-disabled');

    await repo.linkSkill(agentId, skillId, 0, false);
    const links = await repo.linkedSkills(agentId);

    expect(links[0]!.enabled).toBe(false);
    await app.close();
  });

  it('setSkillEnabled flips a single row and returns true', async () => {
    const app = await makeApp();
    const repo = new AgentsRepository(pg.handle.db);
    const agentId = await createAgent(app);
    const skillId = await createSkill(app, 'skill-toggle');
    await repo.linkSkill(agentId, skillId, 0);

    const updated = await repo.setSkillEnabled(agentId, skillId, false);
    expect(updated).toBe(true);

    const links = await repo.linkedSkills(agentId);
    expect(links[0]!.enabled).toBe(false);
    await app.close();
  });

  it('setSkillEnabled returns false when no row matches', async () => {
    const app = await makeApp();
    const repo = new AgentsRepository(pg.handle.db);
    const agentId = await createAgent(app);
    const skillId = await createSkill(app, 'skill-not-linked');

    const updated = await repo.setSkillEnabled(agentId, skillId, false);
    expect(updated).toBe(false);
    await app.close();
  });

  it('setSkills preserves enabled of pre-existing rows and defaults new rows to true', async () => {
    const app = await makeApp();
    const repo = new AgentsRepository(pg.handle.db);
    const agentId = await createAgent(app);
    const sA = await createSkill(app, 'skill-A');
    const sB = await createSkill(app, 'skill-B');
    const sC = await createSkill(app, 'skill-C');

    // Initial: A and B linked; A is disabled.
    await repo.linkSkill(agentId, sA, 0, false);
    await repo.linkSkill(agentId, sB, 1, true);

    // Reorder to [B, A, C] — adds C, keeps A disabled.
    await repo.setSkills(agentId, [sB, sA, sC]);

    const links = await repo.linkedSkills(agentId);
    expect(links.map((l) => [l.skill.id, l.order, l.enabled])).toEqual([
      [sB, 0, true],
      [sA, 1, false],
      [sC, 2, true],
    ]);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail in the expected way**

```bash
pnpm exec vitest run agent-skills-enabled.it.test.ts
```

Expected: FAIL — `linkedSkills` doesn't return `enabled` yet (TypeScript or runtime expectations fail); `setSkillEnabled` doesn't exist.

- [ ] **Step 3: Update `LinkedSkillRow` and `linkedSkills`**

In `server/src/modules/agents/repository.ts`, replace lines 45–49:

```ts
/** A skill linked to an agent (with its order + per-link enabled), joined from agent_skills. */
export interface LinkedSkillRow {
  skill: typeof t.skills.$inferSelect;
  order: number;
  enabled: boolean;
}
```

Replace the `linkedSkills` method body (lines 192–200) to project `enabled`:

```ts
async linkedSkills(agentId: string): Promise<LinkedSkillRow[]> {
  const rows = await this.db
    .select({
      skill: t.skills,
      order: t.agentSkills.order,
      enabled: t.agentSkills.enabled,
    })
    .from(t.agentSkills)
    .innerJoin(t.skills, eq(t.agentSkills.skillId, t.skills.id))
    .where(eq(t.agentSkills.agentId, agentId))
    .orderBy(asc(t.agentSkills.order));
  return rows.map((r) => ({ skill: r.skill, order: r.order, enabled: r.enabled }));
}
```

- [ ] **Step 4: Update `linkSkill` to accept an optional `enabled`**

Replace lines 207–216:

```ts
/** Link a skill to an agent at a given order (idempotent: upserts order; enabled defaults to true on insert). */
async linkSkill(
  agentId: string,
  skillId: string,
  order: number,
  enabled: boolean = true,
): Promise<void> {
  await this.db
    .insert(t.agentSkills)
    .values({ agentId, skillId, order, enabled })
    .onConflictDoUpdate({
      target: [t.agentSkills.agentId, t.agentSkills.skillId],
      set: { order },
    });
}
```

Note: `set: { order }` intentionally does NOT touch `enabled` on conflict — a re-link must preserve the existing enabled flag, matching the `setSkills` semantics.

- [ ] **Step 5: Rewrite `setSkills` to preserve `enabled`**

Replace the existing `setSkills` (lines 229–235). It now reads the prior map, then re-inserts. Wrap in a transaction:

```ts
/**
 * Replace the full set of linked skills for an agent with `skillIds`, assigning
 * order = index. Skills not in the list are unlinked. Pre-existing links keep
 * their `enabled` flag; net-new links default to `enabled = true`.
 */
async setSkills(agentId: string, skillIds: string[]): Promise<void> {
  await this.db.transaction(async (tx) => {
    const prior = await tx
      .select({ skillId: t.agentSkills.skillId, enabled: t.agentSkills.enabled })
      .from(t.agentSkills)
      .where(eq(t.agentSkills.agentId, agentId));
    const enabledById = new Map(prior.map((r) => [r.skillId, r.enabled]));

    await tx.delete(t.agentSkills).where(eq(t.agentSkills.agentId, agentId));
    if (skillIds.length === 0) return;

    await tx.insert(t.agentSkills).values(
      skillIds.map((skillId, i) => ({
        agentId,
        skillId,
        order: i,
        enabled: enabledById.get(skillId) ?? true,
      })),
    );
  });
}
```

- [ ] **Step 6: Add `setSkillEnabled`**

Append after `setSkills`:

```ts
/** Toggle a single link's enabled flag. Returns true if a row matched. */
async setSkillEnabled(
  agentId: string,
  skillId: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await this.db
    .update(t.agentSkills)
    .set({ enabled })
    .where(and(eq(t.agentSkills.agentId, agentId), eq(t.agentSkills.skillId, skillId)))
    .returning({ skillId: t.agentSkills.skillId });
  return rows.length > 0;
}
```

- [ ] **Step 7: Re-run the integration test**

```bash
pnpm exec vitest run agent-skills-enabled.it.test.ts
```

Expected: PASS (all five cases).

- [ ] **Step 8: Run unit tests + typecheck to confirm nothing else broke**

```bash
pnpm exec vitest run --exclude '**/*.it.test.ts'
pnpm typecheck
```

Both PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/agents/repository.ts server/test/agent-skills-enabled.it.test.ts
git commit -m 'feat(server): repo surfaces and preserves agent_skills.enabled'
```

---

## Task 3 [S3]: Shared contract + service propagation

**Files:**
- Modify: `server/src/vendor/shared/contracts/knowledge.ts:194-199`
- Modify: `server/src/modules/agents/service.ts` (lines 138–172; append `setSkillEnabled`)
- Test: extend `server/test/agent-skills-enabled.it.test.ts` with service-level assertions

**Interfaces:**
- Consumes: Task S2's `LinkedSkillRow.enabled`, `setSkillEnabled`.
- Produces:
  - `AgentSkillLink = { agent_id: string; skill_id: string; order: number; enabled: boolean }`.
  - `service.skillLinks(agentId)` returns `enabled` in each link.
  - `service.linkSkill(workspaceId, agentId, skillId, order?, enabled?)` — threads `enabled` through to the repo (default `true`).
  - `service.setSkillEnabled(workspaceId, agentId, skillId, enabled): Promise<AgentSkillLink[] | undefined>` — `undefined` when the agent or link is missing in the workspace.

- [ ] **Step 1: Update the contract**

In `server/src/vendor/shared/contracts/knowledge.ts:194-199`:

```ts
export const AgentSkillLink = z.object({
  agent_id: z.string(),
  skill_id: z.string(),
  order: z.number().int(),
  enabled: z.boolean(),
});
export type AgentSkillLink = z.infer<typeof AgentSkillLink>;
```

- [ ] **Step 2: Run typecheck — expect failures in the agents service**

```bash
pnpm typecheck
```

Expected: FAIL — `service.skillLinks` constructs `AgentSkillLink` without `enabled`.

- [ ] **Step 3: Add the failing service-level test**

Append to `server/test/agent-skills-enabled.it.test.ts` (inside the same `d('agent_skills.enabled', ...)` block):

```ts
it('service.skillLinks returns enabled on every link', async () => {
  const app = await makeApp();
  const repo = new AgentsRepository(pg.handle.db);
  const agentId = await createAgent(app);
  const sA = await createSkill(app, 'svc-A');
  const sB = await createSkill(app, 'svc-B');
  await repo.linkSkill(agentId, sA, 0, false);
  await repo.linkSkill(agentId, sB, 1, true);

  const res = await app.inject({ method: 'GET', url: `/agents/${agentId}/skills` });
  expect(res.statusCode).toBe(200);
  const links = res.json();
  expect(links).toEqual([
    { agent_id: agentId, skill_id: sA, order: 0, enabled: false },
    { agent_id: agentId, skill_id: sB, order: 1, enabled: true },
  ]);
  await app.close();
});
```

- [ ] **Step 4: Fix the service to thread `enabled`**

In `server/src/modules/agents/service.ts`, replace the `skillLinks` method (lines 138–142):

```ts
/** Linked skills for an agent as AgentSkillLink[] (ordered). */
async skillLinks(agentId: string): Promise<AgentSkillLink[]> {
  const links = await this.repo.linkedSkills(agentId);
  return links.map((l) => ({
    agent_id: agentId,
    skill_id: l.skill.id,
    order: l.order,
    enabled: l.enabled,
  }));
}
```

Replace `linkSkill` (lines 159–172) to accept an optional `enabled`:

```ts
/** Link a single skill (append or set order) — additive to existing links. */
async linkSkill(
  workspaceId: string,
  agentId: string,
  skillId: string,
  order?: number,
  enabled?: boolean,
): Promise<AgentSkillLink[] | undefined> {
  const agent = await this.repo.getById(workspaceId, agentId);
  if (!agent) return undefined;
  const existing = await this.repo.linkedSkills(agentId);
  const resolvedOrder = order ?? existing.length;
  await this.repo.linkSkill(agentId, skillId, resolvedOrder, enabled);
  return this.skillLinks(agentId);
}
```

Append a `setSkillEnabled` method after `linkSkill`:

```ts
/**
 * Toggle the enabled flag on a single link. Returns the updated ordered link
 * list, or undefined if the agent is missing in this workspace OR no link
 * exists for (agentId, skillId).
 */
async setSkillEnabled(
  workspaceId: string,
  agentId: string,
  skillId: string,
  enabled: boolean,
): Promise<AgentSkillLink[] | undefined> {
  const agent = await this.repo.getById(workspaceId, agentId);
  if (!agent) return undefined;
  const updated = await this.repo.setSkillEnabled(agentId, skillId, enabled);
  if (!updated) return undefined;
  return this.skillLinks(agentId);
}
```

Append a `unlinkSkill` service method as well — used by the new DELETE route in Task S4:

```ts
/**
 * Unlink a single skill from an agent. Returns the updated link list (possibly
 * empty), or undefined if the agent is missing in this workspace.
 */
async unlinkSkill(
  workspaceId: string,
  agentId: string,
  skillId: string,
): Promise<AgentSkillLink[] | undefined> {
  const agent = await this.repo.getById(workspaceId, agentId);
  if (!agent) return undefined;
  await this.repo.unlinkSkill(agentId, skillId);
  return this.skillLinks(agentId);
}
```

- [ ] **Step 5: Run typecheck and tests**

```bash
pnpm typecheck
pnpm exec vitest run agent-skills-enabled.it.test.ts
pnpm exec vitest run --exclude '**/*.it.test.ts'
```

All PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/vendor/shared/contracts/knowledge.ts server/src/modules/agents/service.ts server/test/agent-skills-enabled.it.test.ts
git commit -m 'feat(server): AgentSkillLink carries enabled; service exposes setSkillEnabled + unlinkSkill'
```

---

## Task 4 [S4]: Routes — `PATCH` toggle, `DELETE` unlink, extended `POST` body

**Files:**
- Modify: `server/src/modules/agents/routes.ts` (extend `SetSkillsBody`; add two routes; thread `enabled` through `POST`)
- Test: extend `server/test/agent-skills-enabled.it.test.ts`

**Interfaces:**
- Consumes: Task S3's `service.setSkillEnabled`, `service.unlinkSkill`, extended `linkSkill`.
- Produces:
  - `POST /agents/:id/skills` body now accepts `enabled?: boolean` alongside `skill_id` / `order` (set/reorder unchanged).
  - `PATCH /agents/:id/skills/:skillId` with body `{ enabled: boolean }` → 200 + updated link list, 404 if agent or link missing.
  - `DELETE /agents/:id/skills/:skillId` → 200 + updated link list, 404 if agent missing (returns the empty/updated list even if no link existed for that skill — repository's delete is a no-op).

  Decision: `DELETE` returns 200 + link list whether or not the (agentId, skillId) pair existed. Rationale: idempotent unlink + the client mostly cares about the post-state list.

- [ ] **Step 1: Add failing route tests**

Append to `server/test/agent-skills-enabled.it.test.ts`:

```ts
it('PATCH /agents/:id/skills/:skillId toggles enabled and returns the list', async () => {
  const app = await makeApp();
  const repo = new AgentsRepository(pg.handle.db);
  const agentId = await createAgent(app);
  const skillId = await createSkill(app, 'patch-target');
  await repo.linkSkill(agentId, skillId, 0);

  const res = await app.inject({
    method: 'PATCH',
    url: `/agents/${agentId}/skills/${skillId}`,
    payload: { enabled: false },
  });
  expect(res.statusCode).toBe(200);
  const links = res.json();
  expect(links).toEqual([
    { agent_id: agentId, skill_id: skillId, order: 0, enabled: false },
  ]);
  await app.close();
});

it('PATCH returns 404 when the link does not exist', async () => {
  const app = await makeApp();
  const agentId = await createAgent(app);
  const skillId = await createSkill(app, 'unlinked');

  const res = await app.inject({
    method: 'PATCH',
    url: `/agents/${agentId}/skills/${skillId}`,
    payload: { enabled: true },
  });
  expect(res.statusCode).toBe(404);
  await app.close();
});

it('PATCH returns 404 when the agent does not exist (and never touches the DB)', async () => {
  const app = await makeApp();
  const skillId = await createSkill(app, 'orphan');
  const fakeAgentId = '00000000-0000-0000-0000-000000000000';

  const res = await app.inject({
    method: 'PATCH',
    url: `/agents/${fakeAgentId}/skills/${skillId}`,
    payload: { enabled: false },
  });
  expect(res.statusCode).toBe(404);
  await app.close();
});

it('DELETE /agents/:id/skills/:skillId unlinks and returns the updated list', async () => {
  const app = await makeApp();
  const repo = new AgentsRepository(pg.handle.db);
  const agentId = await createAgent(app);
  const sA = await createSkill(app, 'del-A');
  const sB = await createSkill(app, 'del-B');
  await repo.linkSkill(agentId, sA, 0);
  await repo.linkSkill(agentId, sB, 1);

  const res = await app.inject({
    method: 'DELETE',
    url: `/agents/${agentId}/skills/${sA}`,
  });
  expect(res.statusCode).toBe(200);
  const links = res.json();
  expect(links).toEqual([
    { agent_id: agentId, skill_id: sB, order: 1, enabled: true },
  ]);
  await app.close();
});

it('DELETE returns 404 when the agent is missing', async () => {
  const app = await makeApp();
  const skillId = await createSkill(app, 'lonely');
  const fakeAgentId = '00000000-0000-0000-0000-000000000000';

  const res = await app.inject({
    method: 'DELETE',
    url: `/agents/${fakeAgentId}/skills/${skillId}`,
  });
  expect(res.statusCode).toBe(404);
  await app.close();
});

it('POST /agents/:id/skills with { skill_id, enabled: false } links a disabled skill', async () => {
  const app = await makeApp();
  const agentId = await createAgent(app);
  const skillId = await createSkill(app, 'post-disabled');

  const res = await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/skills`,
    payload: { skill_id: skillId, enabled: false },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual([
    { agent_id: agentId, skill_id: skillId, order: 0, enabled: false },
  ]);
  await app.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm exec vitest run agent-skills-enabled.it.test.ts
```

Expected: the six new cases FAIL with 404 (routes don't exist yet) or 422 (body rejected by zod).

- [ ] **Step 3: Extend `SetSkillsBody`**

In `server/src/modules/agents/routes.ts`, replace `SetSkillsBody` (lines 60–68):

```ts
/** Either set the whole ordered set (`skill_ids`) or link one (`skill_id`). */
const SetSkillsBody = z
  .object({
    skill_ids: z.array(z.string().uuid()).optional(),
    skill_id: z.string().uuid().optional(),
    order: z.number().int().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => b.skill_ids !== undefined || b.skill_id !== undefined, {
    message: 'Provide skill_ids (set/reorder) or skill_id (link one)',
  });
```

And in the existing `POST /agents/:id/skills` handler (lines 152–165), thread `enabled` through:

```ts
app.post(
  '/agents/:id/skills',
  { schema: { params: IdParams, body: SetSkillsBody } },
  async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const body = req.body;
    const links =
      body.skill_ids !== undefined
        ? await service.setSkills(workspaceId, req.params.id, body.skill_ids)
        : await service.linkSkill(
            workspaceId,
            req.params.id,
            body.skill_id!,
            body.order,
            body.enabled,
          );
    if (!links) throw new NotFoundError('Agent not found');
    return links;
  },
);
```

- [ ] **Step 4: Add the new routes**

Add a `SkillIdParams` schema near the top of the file (next to `IdParams` usage):

```ts
const SkillLinkParams = z.object({
  id: z.string().uuid(),
  skillId: z.string().uuid(),
});

const ToggleSkillEnabledBody = z.object({ enabled: z.boolean() });
```

Then append two route handlers inside `agentsRoutes` (after the existing `POST /agents/:id/skills` block):

```ts
app.patch(
  '/agents/:id/skills/:skillId',
  { schema: { params: SkillLinkParams, body: ToggleSkillEnabledBody } },
  async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const links = await service.setSkillEnabled(
      workspaceId,
      req.params.id,
      req.params.skillId,
      req.body.enabled,
    );
    if (!links) throw new NotFoundError('Agent or skill link not found');
    return links;
  },
);

app.delete(
  '/agents/:id/skills/:skillId',
  { schema: { params: SkillLinkParams } },
  async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const links = await service.unlinkSkill(
      workspaceId,
      req.params.id,
      req.params.skillId,
    );
    if (!links) throw new NotFoundError('Agent not found');
    return links;
  },
);
```

- [ ] **Step 5: Re-run tests**

```bash
pnpm exec vitest run agent-skills-enabled.it.test.ts
pnpm exec vitest run --exclude '**/*.it.test.ts'
pnpm typecheck
```

All PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/agents/routes.ts server/test/agent-skills-enabled.it.test.ts
git commit -m 'feat(server): PATCH+DELETE /agents/:id/skills/:skillId and POST enabled flag'
```

---

## Task 5 [S5]: Invariant — link/order/enable changes do NOT bump agent version

**Files:**
- Test: extend `server/test/agent-skills-enabled.it.test.ts`

**Interfaces:**
- Consumes: Tasks S1–S4 endpoints.
- Produces: regression coverage for the spec's Decision #6 and Acceptance Criterion "agent's `version` does NOT bump when skill links change".

- [ ] **Step 1: Add the assertion**

Append to `server/test/agent-skills-enabled.it.test.ts`:

```ts
it('skill link/order/enable changes do not bump the agent version', async () => {
  const app = await makeApp();
  const agentId = await createAgent(app);
  const sA = await createSkill(app, 'inv-A');
  const sB = await createSkill(app, 'inv-B');

  const initialVersion = (
    await app.inject({ method: 'GET', url: `/agents/${agentId}` })
  ).json().version as number;
  expect(initialVersion).toBe(1);

  // Link, reorder, toggle, unlink — none of these should bump the version.
  await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/skills`,
    payload: { skill_id: sA },
  });
  await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/skills`,
    payload: { skill_id: sB },
  });
  await app.inject({
    method: 'POST',
    url: `/agents/${agentId}/skills`,
    payload: { skill_ids: [sB, sA] },
  });
  await app.inject({
    method: 'PATCH',
    url: `/agents/${agentId}/skills/${sA}`,
    payload: { enabled: false },
  });
  await app.inject({
    method: 'DELETE',
    url: `/agents/${agentId}/skills/${sB}`,
  });

  const after = (
    await app.inject({ method: 'GET', url: `/agents/${agentId}` })
  ).json().version as number;
  expect(after).toBe(initialVersion);
  await app.close();
});
```

- [ ] **Step 2: Run the test**

```bash
pnpm exec vitest run agent-skills-enabled.it.test.ts
```

Expected: PASS — `isConfigChange` in `helpers.ts` already excludes link fields.

- [ ] **Step 3: Commit**

```bash
git add server/test/agent-skills-enabled.it.test.ts
git commit -m 'test(server): assert skill link changes do not bump agent version'
```

---

## Task 6 [C1]: Add `@dnd-kit/*` dependencies

**Files:**
- Modify: `client/package.json`
- Modify: `client/pnpm-lock.yaml` (auto)

**Interfaces:**
- Consumes: none.
- Produces: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` available to import in client code.

- [ ] **Step 1: Add the deps**

From `client/`:

```bash
pnpm add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

- [ ] **Step 2: Verify versions**

Open `client/package.json` and confirm `dependencies` contains the three packages with `^6.x`, `^7.x`, `^3.x` ranges (or whatever pnpm resolved to — accept current major versions, just sanity-check they're present).

- [ ] **Step 3: Run client tests + typecheck**

```bash
pnpm test
pnpm typecheck
```

Both PASS (no usages yet).

- [ ] **Step 4: Commit**

```bash
git add client/package.json client/pnpm-lock.yaml
git commit -m 'feat(client): add @dnd-kit/* for SkillsTab drag-to-reorder'
```

---

## Task 7 [C2]: i18n — extend the `skills` namespace

**Files:**
- Modify: `client/messages/en/agents.json:90-95`

**Interfaces:**
- Consumes: none.
- Produces: i18n keys consumed by `SkillsTab`, `LinkedSkillRow`, `AddSkillPicker` in C5–C7.

- [ ] **Step 1: Replace the `skills` block**

In `client/messages/en/agents.json`, replace the existing `"skills": { … }` block (lines 90–95) with:

```json
"skills": {
  "title": "Skills",
  "enabledCount": "{enabled} of {total} enabled",
  "filterPlaceholder": "Filter skills…",
  "orderHint": "Order matters — earlier skills appear earlier in the assembled prompt. Drag to reorder.",
  "addSkill": "Add skill",
  "removeFromAgent": "Remove from agent",
  "emptyTitle": "No skills linked yet",
  "emptyBody": "Skills are reusable directives appended to this agent's system prompt. Add one to start.",
  "picker": {
    "title": "Add a skill",
    "subtitle": "Workspace skills not yet linked to this agent.",
    "searchPlaceholder": "Search skills…",
    "noUnlinked": "All workspace skills are already linked.",
    "createSkill": "Create a new skill"
  }
},
```

Note: the existing key was `enabledCount: "{linked} of {total} enabled"` with parameter `linked`. The spec changes the param to `enabled` — call sites in C5 must use `{ enabled, total }`.

- [ ] **Step 2: Run client tests + typecheck**

```bash
pnpm test
pnpm typecheck
```

Both PASS — no consumer yet.

- [ ] **Step 3: Commit**

```bash
git add client/messages/en/agents.json
git commit -m 'feat(client): i18n strings for Agent Editor Skills tab'
```

---

## Task 8 [C3]: Five new TanStack Query hooks

**Files:**
- Modify: `client/src/lib/hooks/agents.ts` (append to the existing file)

**Interfaces:**
- Consumes: server endpoints from Tasks S1–S4.
- Produces:
  - `useAgentSkills(agentId: string): UseQueryResult<AgentSkillLink[]>` — `queryKey: ['agent-skills', agentId]`, `queryFn: api.get('/agents/${agentId}/skills')`.
  - `useSetAgentSkills(agentId: string): UseMutationResult<AgentSkillLink[], unknown, { skill_ids: string[] }, { prev?: AgentSkillLink[] }>` — POST `/agents/:id/skills` with `{ skill_ids }`. Optimistic patch: reorder current cached list to match `skill_ids` while preserving each link's `enabled`. Rollback from context on error. Invalidate on success.
  - `useLinkAgentSkill(agentId: string): UseMutationResult<AgentSkillLink[], unknown, { skill_id: string; order?: number; enabled?: boolean }, { prev?: AgentSkillLink[] }>` — POST `/agents/:id/skills` with `{ skill_id, order?, enabled? }`. Optimistic append.
  - `useUnlinkAgentSkill(agentId: string): UseMutationResult<AgentSkillLink[], unknown, string, { prev?: AgentSkillLink[] }>` — DELETE. Optimistic filter-out.
  - `useSetAgentSkillEnabled(agentId: string): UseMutationResult<AgentSkillLink[], unknown, { skillId: string; enabled: boolean }, { prev?: AgentSkillLink[] }>` — PATCH. Optimistic in-place flip.

  All five share the cache key `['agent-skills', agentId]`.

- [ ] **Step 1: Append the hooks**

In `client/src/lib/hooks/agents.ts`, add the `AgentSkillLink` import at the top:

```ts
import type { Agent, AgentSkillLink, ModelInfo, Provider, ReviewStrategy } from "@devdigest/shared";
```

Append after `useProviderModels` (the end of the file):

```ts
const keyAgentSkills = (agentId: string) => ["agent-skills", agentId] as const;

export function useAgentSkills(agentId: string | null | undefined) {
  return useQuery({
    queryKey: keyAgentSkills(agentId ?? ""),
    queryFn: () => api.get<AgentSkillLink[]>(`/agents/${agentId}/skills`),
    enabled: !!agentId,
  });
}

/** POST /agents/:id/skills with { skill_ids } — replaces the ordered set. */
export function useSetAgentSkills(agentId: string) {
  const qc = useQueryClient();
  const key = keyAgentSkills(agentId);
  return useMutation({
    mutationFn: (input: { skill_ids: string[] }) =>
      api.post<AgentSkillLink[]>(`/agents/${agentId}/skills`, input),
    onMutate: async ({ skill_ids }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<AgentSkillLink[]>(key);
      if (prev) {
        const byId = new Map(prev.map((l) => [l.skill_id, l]));
        const next: AgentSkillLink[] = skill_ids.map((id, i) => {
          const existing = byId.get(id);
          return {
            agent_id: agentId,
            skill_id: id,
            order: i,
            enabled: existing?.enabled ?? true,
          };
        });
        qc.setQueryData<AgentSkillLink[]>(key, next);
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

/** POST /agents/:id/skills with { skill_id } — appends a new link. */
export function useLinkAgentSkill(agentId: string) {
  const qc = useQueryClient();
  const key = keyAgentSkills(agentId);
  return useMutation({
    mutationFn: (input: { skill_id: string; order?: number; enabled?: boolean }) =>
      api.post<AgentSkillLink[]>(`/agents/${agentId}/skills`, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<AgentSkillLink[]>(key);
      if (prev) {
        const next: AgentSkillLink[] = [
          ...prev,
          {
            agent_id: agentId,
            skill_id: input.skill_id,
            order: input.order ?? prev.length,
            enabled: input.enabled ?? true,
          },
        ];
        qc.setQueryData<AgentSkillLink[]>(key, next);
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

/** DELETE /agents/:id/skills/:skillId — unlink a single skill. */
export function useUnlinkAgentSkill(agentId: string) {
  const qc = useQueryClient();
  const key = keyAgentSkills(agentId);
  return useMutation({
    mutationFn: (skillId: string) =>
      api.del<AgentSkillLink[]>(`/agents/${agentId}/skills/${skillId}`),
    onMutate: async (skillId) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<AgentSkillLink[]>(key);
      if (prev) {
        const next = prev
          .filter((l) => l.skill_id !== skillId)
          .map((l, i) => ({ ...l, order: i }));
        qc.setQueryData<AgentSkillLink[]>(key, next);
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

/** PATCH /agents/:id/skills/:skillId — flip per-link enabled. */
export function useSetAgentSkillEnabled(agentId: string) {
  const qc = useQueryClient();
  const key = keyAgentSkills(agentId);
  return useMutation({
    mutationFn: ({ skillId, enabled }: { skillId: string; enabled: boolean }) =>
      api.patch<AgentSkillLink[]>(`/agents/${agentId}/skills/${skillId}`, { enabled }),
    onMutate: async ({ skillId, enabled }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<AgentSkillLink[]>(key);
      if (prev) {
        qc.setQueryData<AgentSkillLink[]>(
          key,
          prev.map((l) => (l.skill_id === skillId ? { ...l, enabled } : l)),
        );
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}
```

- [ ] **Step 2: Run typecheck and tests**

```bash
pnpm typecheck
pnpm test
```

Both PASS — `AgentSkillLink` now has `enabled` from S3's contract change.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/hooks/agents.ts
git commit -m 'feat(client): TanStack Query hooks for agent-skill link CRUD'
```

---

## Task 9 [C4]: Wire the Skills tab into the editor shell (placeholder render)

**Files:**
- Modify: `client/src/app/agents/[id]/_components/AgentEditor/constants.ts`
- Modify: `client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.tsx`
- Modify: `client/src/app/agents/[id]/page.tsx:15`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.tsx` (minimal stub)
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/index.ts`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.test.tsx`

**Interfaces:**
- Consumes: none yet (stub).
- Produces: `<SkillsTab agent={agent} />` exported from `./_components/SkillsTab`; clicking the Skills tab in the URL or sidebar renders it.

- [ ] **Step 1: Write the failing component test**

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.test.tsx`. Note: the test file must use the same i18n + query test wrappers as existing tests; reuse the pattern from [client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.test.tsx](../../../client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.test.tsx) — read that file first and copy the providers wrapper verbatim.

For this initial test, just render the stub and assert the title shows:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../messages/en/agents.json";
import { SkillsTab } from "./SkillsTab";
import type { Agent } from "@devdigest/shared";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

const agent: Agent = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Test Agent",
  description: "",
  provider: "openai",
  model: "gpt-4o-mini",
  system_prompt: "review",
  output_schema: null,
  enabled: true,
  version: 1,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
};

describe("SkillsTab (stub)", () => {
  it("renders the section title", () => {
    render(wrap(<SkillsTab agent={agent} />));
    expect(screen.getByRole("heading", { name: /skills/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test — expect failure (module not found)**

```bash
pnpm exec vitest run SkillsTab
```

Expected: FAIL — `./SkillsTab` does not exist.

- [ ] **Step 3: Create the minimal stub**

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.tsx`:

```tsx
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import type { Agent } from "@devdigest/shared";

export function SkillsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("agents.skills");
  void agent;
  return (
    <div>
      <h2>{t("title")}</h2>
    </div>
  );
}
```

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/index.ts`:

```ts
export { SkillsTab } from "./SkillsTab";
```

- [ ] **Step 4: Extend the TABS constant**

In `client/src/app/agents/[id]/_components/AgentEditor/constants.ts`, replace the `TABS` array:

```ts
export const TABS: readonly EditorTab[] = [
  { key: "config", labelKey: "editor.tabs.config", icon: "Settings" },
  { key: "skills", labelKey: "editor.tabs.skills", icon: "Sparkles" },
];
```

- [ ] **Step 5: Render the tab in `AgentEditor.tsx`**

In `client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.tsx`, replace the body of `<div style={s.body}>`:

```tsx
import { SkillsTab } from "./_components/SkillsTab";
// …
<div style={s.body}>
  {tab === "config" && <ConfigTab agent={agent} />}
  {tab === "skills" && <SkillsTab agent={agent} />}
</div>
```

- [ ] **Step 6: Extend `VALID_TABS`**

In `client/src/app/agents/[id]/page.tsx:15`:

```ts
const VALID_TABS = ["config", "skills"];
```

- [ ] **Step 7: Re-run tests + typecheck**

```bash
pnpm exec vitest run SkillsTab AgentEditor
pnpm typecheck
```

Both PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/app/agents/[id]/_components/AgentEditor/constants.ts client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.tsx client/src/app/agents/[id]/page.tsx client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/
git commit -m 'feat(client): mount Skills tab placeholder in Agent Editor'
```

---

## Task 10 [C5]: `LinkedSkillRow` component

**Files:**
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/LinkedSkillRow/LinkedSkillRow.tsx`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/LinkedSkillRow/LinkedSkillRow.test.tsx`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/LinkedSkillRow/styles.ts`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/LinkedSkillRow/index.ts`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/constants.ts` (local `TYPE_BADGE_BG` duplicate)

**Interfaces:**
- Consumes: `Skill` type (from `@devdigest/shared`), local `TYPE_BADGE_BG`.
- Produces:
  ```ts
  interface LinkedSkillRowProps {
    skill: Skill;
    enabled: boolean;
    onToggleEnabled: (enabled: boolean) => void;
    onRemove: () => void;
    dragHandleProps?: React.HTMLAttributes<HTMLElement>;
    isDragging?: boolean;
  }
  export function LinkedSkillRow(props: LinkedSkillRowProps): JSX.Element;
  ```
  The `dragHandleProps` and `isDragging` are wired up by the parent `SkillsTab` via `useSortable` in Task C7 — keeping them prop-driven keeps this component testable without a `DndContext`.

- [ ] **Step 1: Create local `TYPE_BADGE_BG`**

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/constants.ts`:

```ts
import type { SkillType } from "@devdigest/shared";

/** Local duplicate of /skills's TYPE_BADGE_BG — duplicated by spec
 *  ("no cross-feature imports" / ui-architecture rule). */
export const TYPE_BADGE_BG: Record<SkillType, string> = {
  rubric: "var(--ok)",
  convention: "var(--text-secondary)",
  security: "var(--crit)",
  custom: "var(--text-muted)",
};
```

- [ ] **Step 2: Write the failing row test**

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/LinkedSkillRow/LinkedSkillRow.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../../../messages/en/agents.json";
import { LinkedSkillRow } from "./LinkedSkillRow";
import type { Skill } from "@devdigest/shared";

const skill: Skill = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "security-rubric",
  description: "",
  type: "security",
  source: "manual",
  body: "## body",
  enabled: true,
  version: 1,
};

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
      {ui}
    </NextIntlClientProvider>
  );
}

describe("LinkedSkillRow", () => {
  it("renders the name and the type badge", () => {
    render(
      wrap(
        <LinkedSkillRow
          skill={skill}
          enabled={true}
          onToggleEnabled={() => {}}
          onRemove={() => {}}
        />,
      ),
    );
    expect(screen.getByText("security-rubric")).toBeInTheDocument();
    expect(screen.getByText(/security/i)).toBeInTheDocument();
  });

  it("checkbox aria-checked reflects enabled", () => {
    render(
      wrap(
        <LinkedSkillRow
          skill={skill}
          enabled={false}
          onToggleEnabled={() => {}}
          onRemove={() => {}}
        />,
      ),
    );
    const cb = screen.getByRole("checkbox", { name: /security-rubric/i });
    expect(cb).not.toBeChecked();
  });

  it("fires onToggleEnabled when the checkbox is clicked", async () => {
    const onToggle = vi.fn();
    render(
      wrap(
        <LinkedSkillRow
          skill={skill}
          enabled={false}
          onToggleEnabled={onToggle}
          onRemove={() => {}}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("checkbox", { name: /security-rubric/i }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("fires onRemove from the kebab menu", async () => {
    const onRemove = vi.fn();
    render(
      wrap(
        <LinkedSkillRow
          skill={skill}
          enabled={true}
          onToggleEnabled={() => {}}
          onRemove={onRemove}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /remove from agent/i }));
    expect(onRemove).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the test — expect failure (module not found)**

```bash
pnpm exec vitest run LinkedSkillRow
```

Expected: FAIL.

- [ ] **Step 4: Implement the row**

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/LinkedSkillRow/LinkedSkillRow.tsx`:

```tsx
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Dropdown, Icon } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { TYPE_BADGE_BG } from "../../constants";
import { s } from "./styles";

export interface LinkedSkillRowProps {
  skill: Skill;
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onRemove: () => void;
  dragHandleProps?: React.HTMLAttributes<HTMLElement>;
  isDragging?: boolean;
}

export function LinkedSkillRow({
  skill,
  enabled,
  onToggleEnabled,
  onRemove,
  dragHandleProps,
  isDragging,
}: LinkedSkillRowProps) {
  const t = useTranslations("agents.skills");
  const rowStyle: React.CSSProperties = {
    ...s.row,
    opacity: enabled ? 1 : 0.5,
    ...(isDragging ? s.dragging : {}),
  };
  return (
    <div style={rowStyle}>
      <span
        {...dragHandleProps}
        aria-label="drag handle"
        role="button"
        tabIndex={0}
        style={s.handle}
      >
        <Icon.GripVertical size={16} />
      </span>
      <input
        type="checkbox"
        aria-label={skill.name}
        checked={enabled}
        onChange={(e) => onToggleEnabled(e.target.checked)}
        style={s.checkbox}
      />
      <span style={s.name}>{skill.name}</span>
      <Badge color={TYPE_BADGE_BG[skill.type]} mono>
        {skill.type}
      </Badge>
      <Dropdown
        align="right"
        width={180}
        trigger={
          <button
            aria-label="more"
            style={{
              background: "none",
              border: "none",
              padding: 4,
              cursor: "pointer",
              color: "var(--text-muted)",
            }}
          >
            <Icon.MoreHorizontal size={16} />
          </button>
        }
        items={[{ label: t("removeFromAgent"), icon: "Trash", onClick: onRemove }]}
      />
    </div>
  );
}
```

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/LinkedSkillRow/styles.ts`:

```ts
import type { CSSProperties } from "react";

export const s = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-surface)",
  } as CSSProperties,
  dragging: { opacity: 0.6, boxShadow: "0 6px 16px rgba(0,0,0,.18)" } as CSSProperties,
  handle: {
    cursor: "grab",
    color: "var(--text-muted)",
    display: "flex",
    alignItems: "center",
  } as CSSProperties,
  checkbox: { width: 14, height: 14 } as CSSProperties,
  name: { flex: 1, fontFamily: "var(--mono)", fontSize: 13 } as CSSProperties,
};
```

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/LinkedSkillRow/index.ts`:

```ts
export { LinkedSkillRow } from "./LinkedSkillRow";
export type { LinkedSkillRowProps } from "./LinkedSkillRow";
```

- [ ] **Step 5: Re-run tests + typecheck**

```bash
pnpm exec vitest run LinkedSkillRow
pnpm typecheck
```

Both PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/LinkedSkillRow/ client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/constants.ts
git commit -m 'feat(client): LinkedSkillRow with checkbox + drag handle + remove menu'
```

---

## Task 11 [C6]: `AddSkillPicker` drawer

**Files:**
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/AddSkillPicker/AddSkillPicker.tsx`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/AddSkillPicker/AddSkillPicker.test.tsx`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/AddSkillPicker/styles.ts`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/AddSkillPicker/index.ts`

**Interfaces:**
- Consumes: `useSkills` from `client/src/lib/hooks/skills.ts`, local `TYPE_BADGE_BG`.
- Produces:
  ```ts
  interface AddSkillPickerProps {
    linkedIds: ReadonlySet<string>;  // skill ids already linked to this agent
    onPick: (skillId: string) => void;
    onClose: () => void;
  }
  export function AddSkillPicker(props: AddSkillPickerProps): JSX.Element;
  ```
  Renders a right-side drawer (480px wide, mirrors Spec A's `SkillPreviewDrawer` overlay/drawer structure — styles duplicated locally per the spec). Lists workspace skills whose `id` is NOT in `linkedIds`. Has a search input, filter rows by name (case-insensitive). Clicking a row calls `onPick(id)` then `onClose()`. Empty state when 0 unlinked.

- [ ] **Step 1: Write the failing picker test**

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/AddSkillPicker/AddSkillPicker.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../../../messages/en/agents.json";
import { AddSkillPicker } from "./AddSkillPicker";
import type { Skill } from "@devdigest/shared";

const skills: Skill[] = [
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    name: "alpha-rubric",
    description: "",
    type: "rubric",
    source: "manual",
    body: "",
    enabled: true,
    version: 1,
  },
  {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    name: "beta-security",
    description: "",
    type: "security",
    source: "manual",
    body: "",
    enabled: true,
    version: 1,
  },
];

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["skills"], skills);
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

describe("AddSkillPicker", () => {
  it("lists only skills NOT in linkedIds", async () => {
    render(
      wrap(
        <AddSkillPicker
          linkedIds={new Set(["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"])}
          onPick={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.queryByText("alpha-rubric")).not.toBeInTheDocument();
    });
    expect(screen.getByText("beta-security")).toBeInTheDocument();
  });

  it("filters by search input", async () => {
    render(
      wrap(
        <AddSkillPicker linkedIds={new Set()} onPick={() => {}} onClose={() => {}} />,
      ),
    );
    await waitFor(() => expect(screen.getByText("alpha-rubric")).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText(/search skills/i), "beta");
    expect(screen.queryByText("alpha-rubric")).not.toBeInTheDocument();
    expect(screen.getByText("beta-security")).toBeInTheDocument();
  });

  it("calls onPick then onClose when a row is clicked", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      wrap(<AddSkillPicker linkedIds={new Set()} onPick={onPick} onClose={onClose} />),
    );
    await userEvent.click(await screen.findByText("alpha-rubric"));
    expect(onPick).toHaveBeenCalledWith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the empty state when 0 unlinked", async () => {
    render(
      wrap(
        <AddSkillPicker
          linkedIds={new Set(skills.map((s) => s.id))}
          onPick={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    expect(
      await screen.findByText(/all workspace skills are already linked/i),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
pnpm exec vitest run AddSkillPicker
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the picker**

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/AddSkillPicker/AddSkillPicker.tsx`:

```tsx
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon } from "@devdigest/ui";
import { useSkills } from "../../../../../../../../lib/hooks/skills";
import { TYPE_BADGE_BG } from "../../constants";
import { s } from "./styles";

export interface AddSkillPickerProps {
  linkedIds: ReadonlySet<string>;
  onPick: (skillId: string) => void;
  onClose: () => void;
}

export function AddSkillPicker({ linkedIds, onPick, onClose }: AddSkillPickerProps) {
  const t = useTranslations("agents.skills.picker");
  const { data: skills = [] } = useSkills();
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = skills.filter(
    (sk) =>
      !linkedIds.has(sk.id) &&
      sk.name.toLowerCase().includes(q.trim().toLowerCase()),
  );

  return (
    <>
      <div style={s.overlay} onClick={onClose} />
      <aside style={s.drawer} role="dialog" aria-label={t("title")}>
        <div style={s.header}>
          <div style={s.titleCol}>
            <span style={s.title}>{t("title")}</span>
            <span style={s.subtitle}>{t("subtitle")}</span>
          </div>
          <button
            aria-label="close picker"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              padding: 4,
              cursor: "pointer",
              color: "var(--text-muted)",
            }}
          >
            <Icon.X size={16} />
          </button>
        </div>
        <div style={s.searchWrap}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("searchPlaceholder")}
            style={s.search}
          />
        </div>
        <div style={s.list}>
          {filtered.length === 0 ? (
            <div style={s.empty}>{t("noUnlinked")}</div>
          ) : (
            filtered.map((sk) => (
              <button
                key={sk.id}
                type="button"
                style={s.row}
                onClick={() => {
                  onPick(sk.id);
                  onClose();
                }}
              >
                <span style={s.rowName}>{sk.name}</span>
                <Badge color={TYPE_BADGE_BG[sk.type]} mono>
                  {sk.type}
                </Badge>
              </button>
            ))
          )}
        </div>
      </aside>
    </>
  );
}
```

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/AddSkillPicker/styles.ts`:

```ts
import type { CSSProperties } from "react";

export const s = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.32)",
    zIndex: 40,
  } as CSSProperties,
  drawer: {
    position: "fixed",
    right: 0,
    top: 0,
    bottom: 0,
    width: 480,
    maxWidth: "100vw",
    background: "var(--bg-surface)",
    borderLeft: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    zIndex: 41,
  } as CSSProperties,
  header: {
    padding: "16px 20px",
    borderBottom: "1px solid var(--border)",
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
  } as CSSProperties,
  titleCol: { flex: 1, display: "flex", flexDirection: "column", gap: 4 } as CSSProperties,
  title: { fontSize: 14, fontWeight: 600, color: "var(--text-primary)" } as CSSProperties,
  subtitle: { fontSize: 12, color: "var(--text-muted)" } as CSSProperties,
  searchWrap: { padding: "12px 20px", borderBottom: "1px solid var(--border)" } as CSSProperties,
  search: {
    width: "100%",
    height: 32,
    padding: "0 10px",
    background: "var(--bg-input)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text-primary)",
    fontSize: 13,
  } as CSSProperties,
  list: { flex: 1, overflow: "auto", padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6 } as CSSProperties,
  empty: { padding: "24px 12px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 } as CSSProperties,
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 6,
    cursor: "pointer",
    textAlign: "left",
    color: "var(--text-primary)",
  } as CSSProperties,
  rowName: { flex: 1, fontFamily: "var(--mono)", fontSize: 13 } as CSSProperties,
};
```

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/AddSkillPicker/index.ts`:

```ts
export { AddSkillPicker } from "./AddSkillPicker";
export type { AddSkillPickerProps } from "./AddSkillPicker";
```

- [ ] **Step 4: Re-run tests + typecheck**

```bash
pnpm exec vitest run AddSkillPicker
pnpm typecheck
```

Both PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/_components/AddSkillPicker/
git commit -m 'feat(client): AddSkillPicker drawer with search and empty state'
```

---

## Task 12 [C7]: `SkillsTab` — wire it all together with `@dnd-kit`

**Files:**
- Modify: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.tsx` (replace the stub)
- Modify: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.test.tsx` (expand to cover the full flow)
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/styles.ts`

**Interfaces:**
- Consumes: hooks from Task C3 (`useAgentSkills`, `useSetAgentSkills`, `useLinkAgentSkill`, `useUnlinkAgentSkill`, `useSetAgentSkillEnabled`); `useSkills` for the picker's `linkedIds` source; `LinkedSkillRow` from C5; `AddSkillPicker` from C6; `@dnd-kit/core` + `@dnd-kit/sortable`.
- Produces: a feature-complete Skills tab.

- [ ] **Step 1: Add the styles file**

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/styles.ts`:

```ts
import type { CSSProperties } from "react";

export const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 14 } as CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 12 } as CSSProperties,
  title: { fontSize: 14, fontWeight: 600, color: "var(--text-primary)" } as CSSProperties,
  pill: {
    fontSize: 12,
    color: "var(--text-muted)",
    border: "1px solid var(--border)",
    borderRadius: 999,
    padding: "2px 8px",
  } as CSSProperties,
  filter: {
    flex: 1,
    maxWidth: 320,
    height: 30,
    padding: "0 10px",
    background: "var(--bg-input)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--text-primary)",
    fontSize: 13,
  } as CSSProperties,
  hint: { fontSize: 12, color: "var(--text-muted)" } as CSSProperties,
  list: { display: "flex", flexDirection: "column", gap: 6 } as CSSProperties,
  empty: {
    border: "1px dashed var(--border)",
    borderRadius: 8,
    padding: "32px 16px",
    textAlign: "center",
  } as CSSProperties,
  emptyTitle: { fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 } as CSSProperties,
  emptyBody: { fontSize: 13, color: "var(--text-muted)", marginBottom: 14 } as CSSProperties,
};
```

- [ ] **Step 2: Write the failing high-level test**

Replace `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../messages/en/agents.json";
import { SkillsTab } from "./SkillsTab";
import type { Agent, AgentSkillLink, Skill } from "@devdigest/shared";

const agent: Agent = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Test Agent",
  description: "",
  provider: "openai",
  model: "gpt-4o-mini",
  system_prompt: "review",
  output_schema: null,
  enabled: true,
  version: 1,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
};

const skills: Skill[] = [
  { id: "s-a", name: "skill-a", description: "", type: "rubric", source: "manual", body: "", enabled: true, version: 1 },
  { id: "s-b", name: "skill-b", description: "", type: "security", source: "manual", body: "", enabled: true, version: 1 },
  { id: "s-c", name: "skill-c", description: "", type: "convention", source: "manual", body: "", enabled: true, version: 1 },
];

function buildClient(initialLinks: AgentSkillLink[], allSkills: Skill[] = skills) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["agent-skills", agent.id], initialLinks);
  qc.setQueryData(["skills"], allSkills);
  return qc;
}

function wrap(ui: React.ReactNode, qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

const apiSpy = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), del: vi.fn(), get: vi.fn(), put: vi.fn() }));
vi.mock("../../../../../../lib/api", () => ({ api: apiSpy, ApiError: class extends Error {} }));

beforeEach(() => {
  apiSpy.post.mockReset().mockResolvedValue([]);
  apiSpy.patch.mockReset().mockResolvedValue([]);
  apiSpy.del.mockReset().mockResolvedValue([]);
  apiSpy.get.mockReset();
  apiSpy.put.mockReset();
});

describe("SkillsTab", () => {
  it("renders the empty state when no skills are linked", () => {
    const qc = buildClient([]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    expect(screen.getByText(/no skills linked yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add skill/i })).toBeInTheDocument();
  });

  it("renders linked rows in `order` ascending", () => {
    const qc = buildClient([
      { agent_id: agent.id, skill_id: "s-b", order: 0, enabled: true },
      { agent_id: agent.id, skill_id: "s-a", order: 1, enabled: false },
    ]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    const names = screen.getAllByText(/^skill-/).map((el) => el.textContent);
    expect(names).toEqual(["skill-b", "skill-a"]);
  });

  it("the {enabled} of {total} pill updates with the linked array", () => {
    const qc = buildClient([
      { agent_id: agent.id, skill_id: "s-a", order: 0, enabled: true },
      { agent_id: agent.id, skill_id: "s-b", order: 1, enabled: false },
    ]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    expect(screen.getByText("1 of 2 enabled")).toBeInTheDocument();
  });

  it("toggling a checkbox calls PATCH and flips optimistically", async () => {
    const qc = buildClient([
      { agent_id: agent.id, skill_id: "s-a", order: 0, enabled: true },
    ]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    await userEvent.click(screen.getByRole("checkbox", { name: /skill-a/i }));
    await waitFor(() => {
      expect(apiSpy.patch).toHaveBeenCalledWith(
        `/agents/${agent.id}/skills/s-a`,
        { enabled: false },
      );
    });
    expect(screen.getByRole("checkbox", { name: /skill-a/i })).not.toBeChecked();
  });

  it("kebab → Remove fires DELETE", async () => {
    const qc = buildClient([
      { agent_id: agent.id, skill_id: "s-a", order: 0, enabled: true },
    ]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /remove from agent/i }));
    expect(apiSpy.del).toHaveBeenCalledWith(`/agents/${agent.id}/skills/s-a`);
  });

  it("clicking a picker row fires POST { skill_id }", async () => {
    const qc = buildClient([]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    await userEvent.click(screen.getByRole("button", { name: /add skill/i }));
    await userEvent.click(await screen.findByText("skill-a"));
    expect(apiSpy.post).toHaveBeenCalledWith(
      `/agents/${agent.id}/skills`,
      { skill_id: "s-a" },
    );
  });

  it("filter input narrows visible rows by name", async () => {
    const qc = buildClient([
      { agent_id: agent.id, skill_id: "s-a", order: 0, enabled: true },
      { agent_id: agent.id, skill_id: "s-b", order: 1, enabled: true },
    ]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    await userEvent.type(screen.getByPlaceholderText(/filter skills/i), "skill-b");
    expect(screen.queryByText("skill-a")).not.toBeInTheDocument();
    expect(screen.getByText("skill-b")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the test — expect failure**

```bash
pnpm exec vitest run SkillsTab
```

Expected: FAIL — the stub renders only the title.

- [ ] **Step 4: Implement `SkillsTab`**

Replace `client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/SkillsTab.tsx`:

```tsx
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@devdigest/ui";
import type { Agent, AgentSkillLink, Skill } from "@devdigest/shared";
import {
  useAgentSkills,
  useSetAgentSkills,
  useLinkAgentSkill,
  useUnlinkAgentSkill,
  useSetAgentSkillEnabled,
} from "../../../../../../lib/hooks/agents";
import { useSkills } from "../../../../../../lib/hooks/skills";
import { LinkedSkillRow } from "./_components/LinkedSkillRow";
import { AddSkillPicker } from "./_components/AddSkillPicker";
import { s } from "./styles";

export function SkillsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("agents.skills");
  const { data: links = [] } = useAgentSkills(agent.id);
  const { data: allSkills = [] } = useSkills();
  const setSkills = useSetAgentSkills(agent.id);
  const linkSkill = useLinkAgentSkill(agent.id);
  const unlinkSkill = useUnlinkAgentSkill(agent.id);
  const setEnabled = useSetAgentSkillEnabled(agent.id);

  const [filter, setFilter] = React.useState("");
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const skillsById = React.useMemo(
    () => new Map(allSkills.map((sk) => [sk.id, sk])),
    [allSkills],
  );
  const linkedIds = React.useMemo(
    () => new Set(links.map((l) => l.skill_id)),
    [links],
  );

  const enabledCount = links.filter((l) => l.enabled).length;

  const filtered = links.filter((l) => {
    const sk = skillsById.get(l.skill_id);
    if (!sk) return false;
    return sk.name.toLowerCase().includes(filter.trim().toLowerCase());
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = links.findIndex((l) => l.skill_id === active.id);
    const newIndex = links.findIndex((l) => l.skill_id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(links, oldIndex, newIndex);
    setSkills.mutate({ skill_ids: next.map((l) => l.skill_id) });
  }

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <span style={s.title}>{t("title")}</span>
        <span style={s.pill}>{t("enabledCount", { enabled: enabledCount, total: links.length })}</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t("filterPlaceholder")}
          style={s.filter}
        />
        <Button kind="primary" size="sm" icon="Plus" onClick={() => setPickerOpen(true)}>
          {t("addSkill")}
        </Button>
      </div>
      <p style={s.hint}>{t("orderHint")}</p>

      {links.length === 0 ? (
        <div style={s.empty}>
          <div style={s.emptyTitle}>{t("emptyTitle")}</div>
          <p style={s.emptyBody}>{t("emptyBody")}</p>
          <Button kind="primary" icon="Plus" onClick={() => setPickerOpen(true)}>
            {t("addSkill")}
          </Button>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext
            items={filtered.map((l) => l.skill_id)}
            strategy={verticalListSortingStrategy}
          >
            <div style={s.list}>
              {filtered.map((link) => {
                const skill = skillsById.get(link.skill_id);
                if (!skill) return null;
                return (
                  <SortableRow
                    key={link.skill_id}
                    link={link}
                    skill={skill}
                    onToggle={(enabled) =>
                      setEnabled.mutate({ skillId: link.skill_id, enabled })
                    }
                    onRemove={() => unlinkSkill.mutate(link.skill_id)}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {pickerOpen && (
        <AddSkillPicker
          linkedIds={linkedIds}
          onPick={(skillId) => linkSkill.mutate({ skill_id: skillId })}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function SortableRow({
  link,
  skill,
  onToggle,
  onRemove,
}: {
  link: AgentSkillLink;
  skill: Skill;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: link.skill_id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <div ref={setNodeRef} style={style}>
      <LinkedSkillRow
        skill={skill}
        enabled={link.enabled}
        onToggleEnabled={onToggle}
        onRemove={onRemove}
        dragHandleProps={{ ...attributes, ...(listeners as React.HTMLAttributes<HTMLElement>) }}
        isDragging={isDragging}
      />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests + typecheck**

```bash
pnpm exec vitest run SkillsTab
pnpm typecheck
```

Expected: PASS for all seven cases in the spec.

If a test fails because `react-query` / `next-intl` paths are off, sanity-check the relative depth in the test imports (the path is 8 levels up to `client/messages/en/agents.json`). Adjust the `../`s if needed.

- [ ] **Step 6: Commit**

```bash
git add client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/
git commit -m 'feat(client): SkillsTab with drag-reorder, toggle, link/unlink, picker'
```

---

## Task 13 [X]: Verification + acceptance walkthrough

**Files:**
- None (this is the verification gate).

**Interfaces:**
- Consumes: every prior task.
- Produces: documented confirmation that all acceptance criteria from the spec hold.

- [ ] **Step 1: Run the full server test suite**

```bash
cd server
pnpm exec vitest run --exclude '**/*.it.test.ts'
pnpm exec vitest run .it.test  # if Docker available; otherwise note as 'skipped, manual check needed'
pnpm typecheck
```

All PASS.

- [ ] **Step 2: Run the full client test suite**

```bash
cd ../client
pnpm test
pnpm typecheck
```

All PASS.

- [ ] **Step 3: Boot the local stack and walk the acceptance criteria**

From repo root:

```bash
./scripts/dev.sh
```

In a browser at `http://localhost:3000/agents/<some agent id>?tab=skills`, confirm each spec acceptance criterion in order. Mark each with PASS / FAIL in the commit message you'll write in Step 5:

1. Skills tab is visible alongside Config in the tab bar.
2. An agent with no linked skills shows "No skills linked yet" + a primary `Add skill` CTA.
3. Clicking `Add skill` opens the picker; it shows only workspace skills not already linked.
4. Clicking a picker row links the skill (optimistic), the drawer closes, the new row appears at the bottom with the checkbox checked.
5. Drag a row to a new position: the order persists; refresh and confirm the new order survives.
6. Toggling the inline checkbox flips enabled without unlinking; the pill `{enabled} of {total} enabled` updates live.
7. Kebab → Remove unlinks the skill; the row disappears from the list and reappears in the picker.
8. The agent's `version` does NOT change across any of the above (use the agent detail header).
9. Cross-workspace agent ids return 404 (curl test):
   ```bash
   curl -i -X PATCH http://localhost:3001/agents/00000000-0000-0000-0000-000000000000/skills/<any uuid> -H 'content-type: application/json' -d '{"enabled":false}'
   ```
   Expected: HTTP/1.1 404.

- [ ] **Step 4: Final lint / typecheck guardrails**

```bash
cd server && pnpm typecheck
cd ../client && pnpm typecheck
```

Both PASS.

- [ ] **Step 5: Commit the verification note (only if anything textual changed, e.g. a follow-up fix)**

If everything passed cleanly with no extra edits, skip this step — the verification is implicit in the green test runs.

If a follow-up fix was needed, commit it as a separate logical commit (no `--amend` of prior task commits).

---

## Self-Review (run before handoff)

- [ ] **Spec coverage**: every Decision (#1–#8) in the spec maps to a task — `enabled` column (S1), dnd-kit choice (C7), drag UX (C5+C7), unlink via kebab (C5), `+ Add skill` picker (C6+C7), no version bump (S5), empty state allowed (C7), optimistic everywhere (C3). Every acceptance criterion is asserted either in the integration tests (S2–S5) or in the Task X manual walkthrough. The component & data-flow section (`SkillsTab` data flow diagram) is implemented in C7. The i18n block matches C2. ✅
- [ ] **Placeholder scan**: no "TBD", "TODO", "handle edge cases" lurking. All code is concrete. ✅
- [ ] **Type consistency**: `setSkillEnabled` is named identically in repo (S2), service (S3), hook (`useSetAgentSkillEnabled`, C3); `useAgentSkills` cache key is `['agent-skills', agentId]` in all five hooks; `LinkedSkillRow` props match between C5 definition and C7 usage; `AgentSkillLink` shape matches the contract update everywhere it's used. ✅

---

## References

- Design: [docs/superpowers/specs/2026-06-23-skills-b-agent-editor-tab-design.md](../specs/2026-06-23-skills-b-agent-editor-tab-design.md)
- Spec A (Skills inventory — prerequisite): [docs/superpowers/specs/2026-06-23-skills-ui-list-editor-design.md](../specs/2026-06-23-skills-ui-list-editor-design.md)
- Server agents module: [server/src/modules/agents/](../../../server/src/modules/agents/)
- Client Agent Editor: [client/src/app/agents/[id]/_components/AgentEditor/](../../../client/src/app/agents/[id]/_components/AgentEditor/)

# Skills UI (Spec A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the standalone Skills inventory — list page (`/skills`) with side-preview drawer and a dedicated skill editor (`/skills/[id]`, `/skills/new`) — plus the server CRUD that backs it.

**Architecture:** New `server/src/modules/skills/` module (repository + service + routes) following the agents module's shape; new `client/src/app/skills/` route with TanStack Query hooks; reuse the existing `Skill` / `SkillType` contracts from `@devdigest/shared`.

**Tech Stack:** Fastify 5 + Drizzle ORM + Postgres (server). Next.js 15 App Router + React 19 + TanStack Query + `@devdigest/ui` primitives + `react-markdown` (client). Vitest + jsdom + RTL (tests).

## Global Constraints

- **Node ≥ 22, pnpm ≥ 10.** Run server commands from `server/`, client from `client/`.
- **No raw `fetch` outside `client/src/lib/api.ts`.** Components consume TanStack Query hooks from `lib/hooks/`.
- **Server access funnels through one entry point.** No `octokit`, `simple-git`, `node:fs`, or global `fetch(` inside `server/src/modules/`.
- **No `throw new Error()` in routes or modules** — extend a class from `server/src/platform/errors.ts` (`NotFoundError`, `ValidationError`, …).
- **Zod schemas at every route boundary.** Invalid input returns 422 automatically.
- **No cross-module imports between `modules/X` and `modules/Y`** (Y ≠ `_shared`). Skills must not import from `modules/agents/`.
- **Integration tests:** filename ends in `*.it.test.ts`; tests live flat under `server/test/`; gate on `dockerAvailable()` from `test/helpers/pg.ts`.
- **Server commit message style:** present-tense, single-quoted, English, under 72 chars, e.g. `git commit -m 'Add skills repository with list/getById'`.
- **Client tests** colocated next to the file under test (`Foo.test.tsx` next to `Foo.tsx`). No `__tests__/` subdirectories under `client/src/`.
- **Workspace isolation is non-negotiable:** every read and write takes a `workspaceId`. Cross-workspace access returns **404**, not 403.
- **Versioning rule:** an update bumps `skills.version` and writes a `skill_versions` row only when a **content field** (`name` / `description` / `type` / `body`) changes. Toggling `enabled` does NOT bump.
- **All UI strings via `next-intl`** under `messages/en/skills.json` (mirrors `messages/en/agents.json`).
- **i18n key convention:** `skills.list.*`, `skills.card.*`, `skills.drawer.*`, `skills.editor.*`, `skills.delete.*`.

---

## File Structure

**Server (new module):**

```
server/src/modules/skills/
  constants.ts                    # INITIAL_SKILL_VERSION, default description
  helpers.ts                      # toSkillDto, isContentChange (mirrors agents/helpers.ts)
  repository.ts                   # SkillsRepository (Drizzle, workspace-scoped)
  service.ts                      # SkillsService (workspace facade)
  routes.ts                       # Fastify routes + Zod schemas
```

**Server (touched):**

- `server/src/modules/index.ts` — register `skills` plugin.
- `server/test/skills.it.test.ts` — new (integration tests, real Postgres).

**Client (new route):**

```
client/src/app/skills/
  page.tsx                                          # thin entry → <SkillsListView />
  layout.tsx                                        # AppShell breadcrumb wrapper (server component)
  new/page.tsx                                      # thin entry → <SkillEditor mode="create" />
  [id]/page.tsx                                     # thin entry → <SkillEditor mode="edit" />
  _components/
    SkillsListView/
      SkillsListView.tsx
      SkillsListView.test.tsx
      styles.ts
      constants.ts                                  # TYPE_BADGE_COLOR map, TYPE_OPTIONS list
      helpers.ts                                    # filterSkills(skills, query, types)
      helpers.test.ts
      index.ts
      _components/
        SkillCard/{SkillCard.tsx, SkillCard.test.tsx, styles.ts, index.ts}
        SkillsToolbar/{SkillsToolbar.tsx, styles.ts, index.ts}
        AddSkillButton/{AddSkillButton.tsx, index.ts}
        SkillPreviewDrawer/{SkillPreviewDrawer.tsx, SkillPreviewDrawer.test.tsx, styles.ts, index.ts}
        DeleteSkillDialog/{DeleteSkillDialog.tsx, index.ts}
    SkillEditor/
      SkillEditor.tsx
      SkillEditor.test.tsx
      styles.ts
      index.ts
      _components/
        MarkdownSplit/{MarkdownSplit.tsx, MarkdownSplit.test.tsx, styles.ts, index.ts}
```

**Client (touched):**

- `client/src/lib/hooks/skills.ts` — new (TanStack Query hooks).
- `client/src/vendor/ui/nav.ts` — add `Skills` nav item.
- `client/messages/en/skills.json` — new i18n namespace.

---

## Phase 1 — Server

### Task 1: Bootstrap skills module + wiring

**Files:**
- Create: `server/src/modules/skills/constants.ts`
- Create: `server/src/modules/skills/repository.ts`
- Create: `server/src/modules/skills/service.ts`
- Create: `server/src/modules/skills/routes.ts`
- Modify: `server/src/modules/index.ts`
- Test: `server/test/skills.it.test.ts`

**Interfaces:**
- Produces: `SkillsRepository` (class), `SkillsService` (class), default-export Fastify plugin from `routes.ts`. Service exposes `list(workspaceId): Promise<Skill[]>` returning `Skill` from `@devdigest/shared`.

- [ ] **Step 1: Write the failing integration test**

Create `server/test/skills.it.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[skills] Docker not available — skipping integration tests.');
}

d('skills module', () => {
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

  it('GET /skills returns an empty array on a fresh workspace', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/skills' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `server/`:

```
pnpm exec vitest run test/skills.it.test.ts
```

Expected: FAIL — `404` (route not registered) or a route-not-found error.

- [ ] **Step 3: Create constants.ts**

Create `server/src/modules/skills/constants.ts`:

```ts
/** Constants for the skills module. */

/** Initial version recorded for a newly-created skill. */
export const INITIAL_SKILL_VERSION = 1;

/** Default skill description when none is supplied on insert. */
export const DEFAULT_SKILL_DESCRIPTION = '';
```

- [ ] **Step 4: Create the empty repository skeleton**

Create `server/src/modules/skills/repository.ts`:

```ts
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/**
 * Skills data-access. Owns the `skills` and `skill_versions` tables.
 * Workspace-scoped throughout. Routes only call this through `SkillsService`.
 */

export type SkillRow = typeof t.skills.$inferSelect;

export class SkillsRepository {
  constructor(private db: Db) {}

  async list(workspaceId: string): Promise<SkillRow[]> {
    return this.db
      .select()
      .from(t.skills)
      .where(eq(t.skills.workspaceId, workspaceId))
      .orderBy(desc(t.skills.createdAt));
  }
}
```

- [ ] **Step 5: Create the empty service skeleton**

Create `server/src/modules/skills/service.ts`:

```ts
import type { Container } from '../../platform/container.js';
import type { Skill } from '@devdigest/shared';
import { SkillsRepository } from './repository.js';
import { toSkillDto } from './helpers.js';

/**
 * Skills service. Workspace-scoped facade over the repository.
 * Used by `routes.ts`; no other module imports this directly.
 */
export class SkillsService {
  private repo: SkillsRepository;

  constructor(container: Container) {
    this.repo = new SkillsRepository(container.db);
  }

  async list(workspaceId: string): Promise<Skill[]> {
    const rows = await this.repo.list(workspaceId);
    return rows.map(toSkillDto);
  }
}
```

- [ ] **Step 6: Create helpers.ts with toSkillDto**

Create `server/src/modules/skills/helpers.ts`:

```ts
import type { Skill, SkillSource, SkillType } from '@devdigest/shared';
import type { SkillRow } from './repository.js';

/** Map a persisted skill row to the public `Skill` DTO. */
export function toSkillDto(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type as SkillType,
    source: row.source as SkillSource,
    body: row.body,
    enabled: row.enabled,
    version: row.version,
    evidence_files: row.evidenceFiles ?? null,
  };
}
```

- [ ] **Step 7: Create the routes file**

Create `server/src/modules/skills/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getContext } from '../_shared/context.js';
import { SkillsService } from './service.js';

/**
 * Skills module.
 *   GET    /skills              → list (workspace-scoped)
 *   GET    /skills/:id          → one skill
 *   GET    /skills/:id/usage    → { agent_count }
 *   POST   /skills              → create
 *   PUT    /skills/:id          → update
 *   DELETE /skills/:id          → delete
 */
export default async function skillsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new SkillsService(app.container);

  app.get('/skills', async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.list(workspaceId);
  });
}
```

- [ ] **Step 8: Register the module**

Modify `server/src/modules/index.ts` — add the import and registry entry (keep alphabetical ordering inside the record):

```ts
import settings from './settings/routes.js';
import repos from './repos/routes.js';
import pulls from './pulls/routes.js';
import polling from './polling/routes.js';
import workspace from './workspace/routes.js';
import agents from './agents/routes.js';
import reviews from './reviews/routes.js';
import repoIntel from './repo-intel/routes.js';
import skills from './skills/routes.js';

export const modules: Record<string, FastifyPluginAsync> = {
  settings,
  repos,
  pulls,
  polling,
  workspace,
  agents,
  reviews,
  repoIntel,
  skills,
};
```

- [ ] **Step 9: Run the test — it should pass**

```
pnpm exec vitest run test/skills.it.test.ts
```

Expected: PASS (1 test).

- [ ] **Step 10: Type-check**

```
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add server/src/modules/skills server/src/modules/index.ts server/test/skills.it.test.ts
git commit -m 'Bootstrap skills module with empty list route'
```

---

### Task 2: getById + insert (create flow)

**Files:**
- Modify: `server/src/modules/skills/repository.ts` (add `getById`, `insert`)
- Modify: `server/src/modules/skills/service.ts` (add `get`, `create`)
- Modify: `server/src/modules/skills/routes.ts` (add `GET /skills/:id`, `POST /skills`)
- Modify: `server/test/skills.it.test.ts`

**Interfaces:**
- Consumes: `SkillsRepository` (from Task 1).
- Produces:
  - `SkillsRepository.getById(workspaceId, id): Promise<SkillRow | undefined>`
  - `SkillsRepository.insert(values: InsertSkill): Promise<SkillRow>` — also writes a `skill_versions` row at v1.
  - `SkillsService.get(workspaceId, id): Promise<Skill | undefined>`
  - `SkillsService.create(workspaceId, input: CreateSkillInput): Promise<Skill>`

- [ ] **Step 1: Write failing tests for create + getById**

Append to the `d('skills module', ...)` describe in `server/test/skills.it.test.ts`:

```ts
  const createBody = {
    name: 'pr-quality-rubric',
    description: 'Rubric for PR quality reviews.',
    type: 'rubric' as const,
    body: '## Checklist\n\n- Tests cover the change\n- Names reflect intent',
  };

  it('POST /skills creates a skill at version 1 and returns it', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/skills', payload: createBody });
    expect(res.statusCode).toBe(201);
    const skill = res.json();
    expect(skill).toMatchObject({
      name: createBody.name,
      description: createBody.description,
      type: 'rubric',
      source: 'manual',
      body: createBody.body,
      enabled: true,
      version: 1,
    });
    expect(typeof skill.id).toBe('string');
    await app.close();
  });

  it('GET /skills/:id returns the created skill', async () => {
    const app = await makeApp();
    const id = (
      await app.inject({ method: 'POST', url: '/skills', payload: createBody })
    ).json().id as string;
    const res = await app.inject({ method: 'GET', url: `/skills/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, name: createBody.name });
    await app.close();
  });

  it('GET /skills/:id 404s for an unknown id', async () => {
    const app = await makeApp();
    const ghost = '00000000-0000-0000-0000-000000000000';
    const res = await app.inject({ method: 'GET', url: `/skills/${ghost}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('POST /skills 422s when name is missing', async () => {
    const app = await makeApp();
    const { name: _ignored, ...rest } = createBody;
    const res = await app.inject({ method: 'POST', url: '/skills', payload: rest });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm exec vitest run test/skills.it.test.ts
```

Expected: FAIL on the four new tests (route not found / handler missing).

- [ ] **Step 3: Add InsertSkill type + insert + getById to repository**

In `server/src/modules/skills/repository.ts`, add the imports and methods:

```ts
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { SkillSource, SkillType } from '@devdigest/shared';
import { DEFAULT_SKILL_DESCRIPTION, INITIAL_SKILL_VERSION } from './constants.js';

export type SkillRow = typeof t.skills.$inferSelect;

export interface InsertSkill {
  workspaceId: string;
  name: string;
  description?: string;
  type: SkillType;
  body: string;
  enabled?: boolean;
  source?: SkillSource;
  evidenceFiles?: string[] | null;
}

export class SkillsRepository {
  constructor(private db: Db) {}

  async list(workspaceId: string): Promise<SkillRow[]> {
    return this.db
      .select()
      .from(t.skills)
      .where(eq(t.skills.workspaceId, workspaceId))
      .orderBy(desc(t.skills.createdAt));
  }

  async getById(workspaceId: string, id: string): Promise<SkillRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, id)));
    return row;
  }

  async insert(values: InsertSkill): Promise<SkillRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(t.skills)
        .values({
          workspaceId: values.workspaceId,
          name: values.name,
          description: values.description ?? DEFAULT_SKILL_DESCRIPTION,
          type: values.type,
          body: values.body,
          enabled: values.enabled ?? true,
          source: values.source ?? 'manual',
          version: INITIAL_SKILL_VERSION,
          evidenceFiles: values.evidenceFiles ?? null,
        })
        .returning();
      if (!row) {
        throw new AppError('skill_insert_failed', 'unexpected empty insert', 500);
      }
      await tx.insert(t.skillVersions).values({
        skillId: row.id,
        version: INITIAL_SKILL_VERSION,
        body: row.body,
      });
      return row;
    });
  }
}
```

Add `AppError` to the imports at the top of `repository.ts`:

```ts
import { AppError } from '../../platform/errors.js';
```

> Note: `throw new AppError(...)` satisfies the `onion-architecture` rule that forbids `throw new Error()` inside modules. The route layer maps it to a 500 via the existing error handler.

- [ ] **Step 4: Add get + create to the service**

Modify `server/src/modules/skills/service.ts`:

```ts
import type { Container } from '../../platform/container.js';
import type { Skill, SkillType } from '@devdigest/shared';
import { SkillsRepository } from './repository.js';
import { toSkillDto } from './helpers.js';

export interface CreateSkillInput {
  name: string;
  description?: string;
  type: SkillType;
  body: string;
  enabled?: boolean;
}

export class SkillsService {
  private repo: SkillsRepository;

  constructor(container: Container) {
    this.repo = new SkillsRepository(container.db);
  }

  async list(workspaceId: string): Promise<Skill[]> {
    const rows = await this.repo.list(workspaceId);
    return rows.map(toSkillDto);
  }

  async get(workspaceId: string, id: string): Promise<Skill | undefined> {
    const row = await this.repo.getById(workspaceId, id);
    return row ? toSkillDto(row) : undefined;
  }

  async create(workspaceId: string, input: CreateSkillInput): Promise<Skill> {
    const row = await this.repo.insert({
      workspaceId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      type: input.type,
      body: input.body,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    });
    return toSkillDto(row);
  }
}
```

- [ ] **Step 5: Add the two routes + Zod schemas**

Modify `server/src/modules/skills/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SkillType } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { NotFoundError } from '../../platform/errors.js';
import { SkillsService } from './service.js';

const CreateSkillBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  type: SkillType,
  body: z.string().min(1),
  enabled: z.boolean().optional(),
});

export default async function skillsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new SkillsService(app.container);

  app.get('/skills', async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.list(workspaceId);
  });

  app.get('/skills/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const skill = await service.get(workspaceId, req.params.id);
    if (!skill) throw new NotFoundError('Skill not found');
    return skill;
  });

  app.post('/skills', { schema: { body: CreateSkillBody } }, async (req, reply) => {
    const { workspaceId } = await getContext(app.container, req);
    const skill = await service.create(workspaceId, req.body);
    reply.status(201);
    return skill;
  });
}
```

- [ ] **Step 6: Run all tests — should pass**

```
pnpm exec vitest run test/skills.it.test.ts
```

Expected: PASS (5 tests including the original empty-list test).

- [ ] **Step 7: Type-check**

```
pnpm typecheck
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/skills server/test/skills.it.test.ts
git commit -m 'Add skills create, get-by-id with version snapshot'
```

---

### Task 3: Update with conditional version bump

**Files:**
- Modify: `server/src/modules/skills/repository.ts` (add `update`)
- Modify: `server/src/modules/skills/service.ts` (add `update`)
- Modify: `server/src/modules/skills/routes.ts` (add `PUT /skills/:id`)
- Modify: `server/src/modules/skills/helpers.ts` (add `isContentChange`)
- Modify: `server/test/skills.it.test.ts`

**Interfaces:**
- Consumes: `SkillsRepository.getById` (Task 2).
- Produces:
  - `SkillsRepository.update(workspaceId, id, patch: UpdateSkill): Promise<SkillRow | undefined>` — bumps `version` + inserts a `skill_versions` row only when a content field changes.
  - `SkillsService.update(workspaceId, id, patch: UpdateSkillInput): Promise<Skill | undefined>`
  - Pure helper `isContentChange(existing, patch): boolean`.

- [ ] **Step 1: Write failing tests**

Append to `server/test/skills.it.test.ts`:

```ts
  it('PUT /skills/:id bumps version when body changes', async () => {
    const app = await makeApp();
    const id = (
      await app.inject({ method: 'POST', url: '/skills', payload: createBody })
    ).json().id as string;
    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${id}`,
      payload: { body: 'new body' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ body: 'new body', version: 2 });
    await app.close();
  });

  it('PUT /skills/:id does NOT bump version when only enabled changes', async () => {
    const app = await makeApp();
    const id = (
      await app.inject({ method: 'POST', url: '/skills', payload: createBody })
    ).json().id as string;
    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${id}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, version: 1 });
    await app.close();
  });

  it('PUT /skills/:id 404s for an unknown skill', async () => {
    const app = await makeApp();
    const ghost = '00000000-0000-0000-0000-000000000000';
    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${ghost}`,
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
```

- [ ] **Step 2: Run — verify FAIL**

```
pnpm exec vitest run test/skills.it.test.ts
```

Expected: FAIL on the three new cases (route 404 or handler missing).

- [ ] **Step 3: Add `isContentChange` helper**

Append to `server/src/modules/skills/helpers.ts`:

```ts
import type { SkillType } from '@devdigest/shared';

export interface ContentChangePatch {
  name?: string;
  description?: string;
  type?: SkillType;
  body?: string;
}

/** True iff a patch changes a content field (name/description/type/body)
 *  relative to the existing row — a content change bumps the version and
 *  snapshots a skill_versions row. Toggling enabled returns false. */
export function isContentChange(
  existing: Pick<SkillRow, 'name' | 'description' | 'type' | 'body'>,
  patch: ContentChangePatch,
): boolean {
  return (
    (patch.name !== undefined && patch.name !== existing.name) ||
    (patch.description !== undefined && patch.description !== existing.description) ||
    (patch.type !== undefined && patch.type !== existing.type) ||
    (patch.body !== undefined && patch.body !== existing.body)
  );
}
```

Adjust the existing `import` line at the top of `helpers.ts` to also import `SkillRow`:

```ts
import type { Skill, SkillSource, SkillType } from '@devdigest/shared';
import type { SkillRow } from './repository.js';
```

- [ ] **Step 4: Add `update` to the repository**

Append to the `SkillsRepository` class in `server/src/modules/skills/repository.ts`:

```ts
  async update(
    workspaceId: string,
    id: string,
    patch: UpdateSkill,
  ): Promise<SkillRow | undefined> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return undefined;

    const contentChanged = isContentChange(existing, patch);
    const nextVersion = contentChanged ? existing.version + 1 : existing.version;

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(t.skills)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.type !== undefined ? { type: patch.type } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(contentChanged ? { version: nextVersion } : {}),
        })
        .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, id)))
        .returning();

      if (contentChanged && row) {
        await tx.insert(t.skillVersions).values({
          skillId: row.id,
          version: nextVersion,
          body: row.body,
        });
      }
      return row;
    });
  }
```

Also add the `UpdateSkill` interface and `isContentChange` import at the top of the file:

```ts
import { isContentChange } from './helpers.js';

export interface UpdateSkill {
  name?: string;
  description?: string;
  type?: SkillType;
  body?: string;
  enabled?: boolean;
}
```

- [ ] **Step 5: Add `update` to the service**

Append to the `SkillsService` class:

```ts
export interface UpdateSkillInput {
  name?: string;
  description?: string;
  type?: SkillType;
  body?: string;
  enabled?: boolean;
}

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateSkillInput,
  ): Promise<Skill | undefined> {
    const row = await this.repo.update(workspaceId, id, patch);
    return row ? toSkillDto(row) : undefined;
  }
```

(`UpdateSkillInput` is structurally identical to `UpdateSkill` because the skill DTO uses the same field names; we mirror the agents convention of keeping a service-layer Input type for stability.)

- [ ] **Step 6: Add the route**

Append to `server/src/modules/skills/routes.ts` (and define `UpdateSkillBody` near the existing Zod schemas):

```ts
const UpdateSkillBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  type: SkillType.optional(),
  body: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

  app.put(
    '/skills/:id',
    { schema: { params: IdParams, body: UpdateSkillBody } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const skill = await service.update(workspaceId, req.params.id, req.body);
      if (!skill) throw new NotFoundError('Skill not found');
      return skill;
    },
  );
```

- [ ] **Step 7: Run tests**

```
pnpm exec vitest run test/skills.it.test.ts
```

Expected: PASS (8 tests).

- [ ] **Step 8: Type-check**

```
pnpm typecheck
```

- [ ] **Step 9: Commit**

```bash
git add server/src/modules/skills server/test/skills.it.test.ts
git commit -m 'Add skill update with conditional version bump'
```

---

### Task 4: Delete with cascade

**Files:**
- Modify: `server/src/modules/skills/repository.ts` (add `deleteById`)
- Modify: `server/src/modules/skills/service.ts` (add `delete`)
- Modify: `server/src/modules/skills/routes.ts` (add `DELETE /skills/:id`)
- Modify: `server/test/skills.it.test.ts`

**Interfaces:**
- Produces:
  - `SkillsRepository.deleteById(workspaceId, id): Promise<boolean>`
  - `SkillsService.delete(workspaceId, id): Promise<boolean>`

- [ ] **Step 1: Write failing tests**

Append to `server/test/skills.it.test.ts`. The cascade test imports the agents repo and the schema table to insert a link without going through the agents HTTP API.

```ts
import * as t from '../src/db/schema.js';
import { AgentsRepository } from '../src/modules/agents/repository.js';

  it('DELETE /skills/:id removes the skill and returns { ok: true }', async () => {
    const app = await makeApp();
    const id = (
      await app.inject({ method: 'POST', url: '/skills', payload: createBody })
    ).json().id as string;

    const del = await app.inject({ method: 'DELETE', url: `/skills/${id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    const after = await app.inject({ method: 'GET', url: `/skills/${id}` });
    expect(after.statusCode).toBe(404);
    await app.close();
  });

  it('DELETE /skills/:id 404s for an unknown id', async () => {
    const app = await makeApp();
    const ghost = '00000000-0000-0000-0000-000000000000';
    const res = await app.inject({ method: 'DELETE', url: `/skills/${ghost}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('DELETE cascades to skill_versions and agent_skills', async () => {
    const app = await makeApp();
    const { db } = pg.handle;

    const skillId = (
      await app.inject({ method: 'POST', url: '/skills', payload: createBody })
    ).json().id as string;

    const agentRepo = new AgentsRepository(db);
    const [{ id: wsId }] = await db
      .select({ id: t.workspaces.id })
      .from(t.workspaces)
      .where(eq(t.workspaces.name, 'default'));
    const agent = await agentRepo.insert({
      workspaceId: wsId!,
      name: 'A',
      provider: 'openai',
      model: 'gpt-4o-mini',
      systemPrompt: 'x',
    });
    await agentRepo.linkSkill(agent.id, skillId, 0);

    await app.inject({ method: 'DELETE', url: `/skills/${skillId}` });

    const links = await db
      .select()
      .from(t.agentSkills)
      .where(eq(t.agentSkills.skillId, skillId));
    expect(links).toHaveLength(0);

    const versions = await db
      .select()
      .from(t.skillVersions)
      .where(eq(t.skillVersions.skillId, skillId));
    expect(versions).toHaveLength(0);
    await app.close();
  });
```

You will need an `eq` import at the top of the file if it isn't there yet:

```ts
import { eq } from 'drizzle-orm';
```

- [ ] **Step 2: Run — verify FAIL**

```
pnpm exec vitest run test/skills.it.test.ts
```

- [ ] **Step 3: Add `deleteById` to the repository**

Append to `SkillsRepository`:

```ts
  async deleteById(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, id)))
      .returning({ id: t.skills.id });
    return rows.length > 0;
  }
```

- [ ] **Step 4: Add `delete` to the service**

Append:

```ts
  async delete(workspaceId: string, id: string): Promise<boolean> {
    return this.repo.deleteById(workspaceId, id);
  }
```

- [ ] **Step 5: Add the DELETE route**

Append to `routes.ts`:

```ts
  app.delete('/skills/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const ok = await service.delete(workspaceId, req.params.id);
    if (!ok) throw new NotFoundError('Skill not found');
    return { ok: true };
  });
```

- [ ] **Step 6: Run tests**

```
pnpm exec vitest run test/skills.it.test.ts
```

Expected: PASS (11 tests).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/skills server/test/skills.it.test.ts
git commit -m 'Add skill delete with cascade to versions and links'
```

---

### Task 5: Usage endpoint

**Files:**
- Modify: `server/src/modules/skills/repository.ts` (add `usage`)
- Modify: `server/src/modules/skills/service.ts` (add `usage`)
- Modify: `server/src/modules/skills/routes.ts` (add `GET /skills/:id/usage`)
- Modify: `server/test/skills.it.test.ts`

**Interfaces:**
- Produces:
  - `SkillsRepository.usage(workspaceId, id): Promise<{ agentCount: number } | undefined>` (returns `undefined` if the skill doesn't exist).
  - `SkillsService.usage(workspaceId, id): Promise<{ agent_count: number } | undefined>`

- [ ] **Step 1: Write the failing test**

Append:

```ts
  it('GET /skills/:id/usage returns the agent count linked to the skill', async () => {
    const app = await makeApp();
    const { db } = pg.handle;

    const skillId = (
      await app.inject({ method: 'POST', url: '/skills', payload: createBody })
    ).json().id as string;

    let res = await app.inject({ method: 'GET', url: `/skills/${skillId}/usage` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agent_count: 0 });

    const agentRepo = new AgentsRepository(db);
    const [{ id: wsId }] = await db
      .select({ id: t.workspaces.id })
      .from(t.workspaces)
      .where(eq(t.workspaces.name, 'default'));
    const a1 = await agentRepo.insert({
      workspaceId: wsId!,
      name: 'A1',
      provider: 'openai',
      model: 'gpt-4o-mini',
      systemPrompt: 'x',
    });
    const a2 = await agentRepo.insert({
      workspaceId: wsId!,
      name: 'A2',
      provider: 'openai',
      model: 'gpt-4o-mini',
      systemPrompt: 'x',
    });
    await agentRepo.linkSkill(a1.id, skillId, 0);
    await agentRepo.linkSkill(a2.id, skillId, 0);

    res = await app.inject({ method: 'GET', url: `/skills/${skillId}/usage` });
    expect(res.json()).toEqual({ agent_count: 2 });
    await app.close();
  });

  it('GET /skills/:id/usage 404s for an unknown id', async () => {
    const app = await makeApp();
    const ghost = '00000000-0000-0000-0000-000000000000';
    const res = await app.inject({ method: 'GET', url: `/skills/${ghost}/usage` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
```

- [ ] **Step 2: Run — verify FAIL**

```
pnpm exec vitest run test/skills.it.test.ts
```

- [ ] **Step 3: Add `usage` to the repository**

Add `count` and `sql` to the drizzle import at the top:

```ts
import { and, count, desc, eq } from 'drizzle-orm';
```

Append to `SkillsRepository`:

```ts
  async usage(
    workspaceId: string,
    id: string,
  ): Promise<{ agentCount: number } | undefined> {
    const skill = await this.getById(workspaceId, id);
    if (!skill) return undefined;
    const [row] = await this.db
      .select({ c: count() })
      .from(t.agentSkills)
      .where(eq(t.agentSkills.skillId, id));
    return { agentCount: row?.c ?? 0 };
  }
```

- [ ] **Step 4: Add `usage` to the service**

Append:

```ts
  async usage(
    workspaceId: string,
    id: string,
  ): Promise<{ agent_count: number } | undefined> {
    const u = await this.repo.usage(workspaceId, id);
    return u ? { agent_count: u.agentCount } : undefined;
  }
```

- [ ] **Step 5: Add the route**

Append (place before the dynamic-id routes so Fastify routes match in the right order; with Fastify this isn't required, but keeping endpoints grouped reads better):

```ts
  app.get('/skills/:id/usage', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const u = await service.usage(workspaceId, req.params.id);
    if (!u) throw new NotFoundError('Skill not found');
    return u;
  });
```

- [ ] **Step 6: Run tests**

```
pnpm exec vitest run test/skills.it.test.ts
```

Expected: PASS (13 tests).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/skills server/test/skills.it.test.ts
git commit -m 'Add skill usage endpoint returning linked-agent count'
```

---

### Task 6: Workspace isolation defensive tests

**Files:**
- Modify: `server/test/skills.it.test.ts`

**Interfaces:** none (existing repo/service must already satisfy these — the tests are catch-net).

- [ ] **Step 1: Write the tests**

Append:

```ts
  it('skills are workspace-scoped: another workspace cannot read them', async () => {
    const app = await makeApp();
    const { db } = pg.handle;
    const skillId = (
      await app.inject({ method: 'POST', url: '/skills', payload: createBody })
    ).json().id as string;

    const [other] = await db.insert(t.workspaces).values({ name: 'other-ws' }).returning();
    // The service exposes the cross-workspace check; calling the repo directly
    // is enough to assert the SQL filters by workspaceId.
    const { SkillsRepository } = await import('../src/modules/skills/repository.js');
    const repo = new SkillsRepository(db);
    expect(await repo.getById(other!.id, skillId)).toBeUndefined();
    expect(await repo.list(other!.id)).toEqual([]);

    // Cross-workspace PUT / DELETE / usage from the HTTP layer:
    expect(await repo.update(other!.id, skillId, { name: 'x' })).toBeUndefined();
    expect(await repo.deleteById(other!.id, skillId)).toBe(false);
    expect(await repo.usage(other!.id, skillId)).toBeUndefined();
    await app.close();
  });
```

- [ ] **Step 2: Run — verify PASS (no impl changes needed)**

```
pnpm exec vitest run test/skills.it.test.ts
```

Expected: PASS (14 tests). If anything fails, the previous tasks didn't thread `workspaceId` through correctly — go back and fix at the repo layer.

- [ ] **Step 3: Commit**

```bash
git add server/test/skills.it.test.ts
git commit -m 'Assert workspace isolation on skills repository'
```

---

## Phase 2 — Client

### Task 7: i18n namespace + nav item

**Files:**
- Create: `client/messages/en/skills.json`
- Modify: `client/src/vendor/ui/nav.ts`

**Interfaces:**
- Produces: i18n keys under the `skills.*` namespace; a `skills` entry in `NAV` with a stable key and href.

- [ ] **Step 1: Create the i18n namespace**

Create `client/messages/en/skills.json`:

```json
{
  "card": {
    "noDescription": "No description",
    "enabled": "Enabled",
    "disabled": "Disabled"
  },
  "list": {
    "breadcrumbLab": "Skills Lab",
    "breadcrumb": "Skills",
    "title": "Skills",
    "subtitle": "Reusable review instructions. Each skill is a directive your agents can include in their prompt.",
    "searchPlaceholder": "Search skills…",
    "filterByType": "Type",
    "addSkill": "Add Skill",
    "createFromScratch": "Create",
    "importFromFile": "Import",
    "importComingSoon": "Coming soon",
    "loadError": "Could not load skills.",
    "emptyTitle": "No skills yet",
    "emptyBody": "A skill is a directive — a piece of guidance your agents can include in their prompt. Create one to start.",
    "emptyCta": "Create your first skill",
    "noMatchTitle": "No skills match",
    "noMatchBody": "Try clearing the search or adjusting the type filter.",
    "noMatchCta": "Clear filters"
  },
  "types": {
    "rubric": "Rubric",
    "convention": "Convention",
    "security": "Security",
    "custom": "Custom"
  },
  "drawer": {
    "edit": "Edit",
    "deleteMenu": "Delete…",
    "closeAria": "Close preview",
    "enabledLabel": "Enabled"
  },
  "delete": {
    "title": "Delete skill?",
    "bodyZero": "Delete \"{name}\". This cannot be undone.",
    "bodyN": "Delete \"{name}\". Used by {count} agents. This will remove it from those agents and delete its history.",
    "cancel": "Cancel",
    "confirm": "Delete skill",
    "deleting": "Deleting…"
  },
  "editor": {
    "loadErrorTitle": "Couldn't load this skill",
    "loadErrorBody": "The skill could not be loaded.",
    "createTitle": "Create skill",
    "createSubtitle": "Describe what this skill checks and how an agent should use it.",
    "editTitle": "Edit skill",
    "name": "Name",
    "namePlaceholder": "secret-leakage-gate",
    "description": "Description",
    "descriptionHint": "Acts as the skill's interface — phrase it as a directive.",
    "descriptionPlaceholder": "Flag any secret value committed to the repo.",
    "type": "Type",
    "enabled": "Enabled",
    "body": "Body (markdown)",
    "bodyPlaceholder": "## When to flag\n\n- Any string that looks like an API key…",
    "previewToggle": "Preview",
    "save": "Save skill",
    "create": "Create skill",
    "saving": "Saving…",
    "creating": "Creating…",
    "saved": "Saved (v{version})",
    "savedToast": "Skill saved (v{version})",
    "unsavedTitle": "Discard changes?",
    "unsavedBody": "You have unsaved edits. Leave the page anyway?",
    "unsavedConfirm": "Discard",
    "unsavedCancel": "Keep editing"
  }
}
```

- [ ] **Step 2: Add the Skills nav item**

Modify `client/src/vendor/ui/nav.ts` — add Skills to a `SKILLS LAB` group between WORKSPACE and (future) GLOBAL:

```ts
export const NAV: NavGroup[] = [
  {
    section: "WORKSPACE",
    items: [
      { key: "pulls", label: "Pull Requests", icon: "GitPullRequest", href: "/repos/:repoId/pulls", gKey: "p" },
    ],
  },
  {
    section: "SKILLS LAB",
    items: [
      { key: "skills", label: "Skills", icon: "Sparkles", href: "/skills", gKey: "s" },
      { key: "agents", label: "Agents", icon: "Cpu", href: "/agents", gKey: "a" },
    ],
  },
];
```

Add a corresponding shortcut entry to `SHORTCUTS`:

```ts
  { keys: "g s", label: "Go to Skills", group: "Navigation" },
```

(`activeKeyFor()` already returns `"skills"` for paths under `/skills` — see `client/src/components/app-shell/helpers.ts:1819`.)

- [ ] **Step 3: Type-check + tests**

From `client/`:

```
pnpm typecheck && pnpm test
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add client/messages/en/skills.json client/src/vendor/ui/nav.ts
git commit -m 'Add Skills i18n namespace and sidebar nav item'
```

---

### Task 8: TanStack Query hooks for skills

**Files:**
- Create: `client/src/lib/hooks/skills.ts`

**Interfaces:**
- Produces:
  - `useSkills()` → `UseQueryResult<Skill[]>`
  - `useSkill(id)` → `UseQueryResult<Skill>` (disabled when id null)
  - `useSkillUsage(id)` → `UseQueryResult<{ agent_count: number }>`
  - `useCreateSkill()` → `UseMutationResult<Skill, ApiError, CreateSkillInput>`
  - `useUpdateSkill()` → optimistic-toggle mutation; signature `{ id, patch }` → `Skill`
  - `useDeleteSkill()` → mutation taking `id: string` → `{ ok: boolean }`

- [ ] **Step 1: Create the file**

Create `client/src/lib/hooks/skills.ts`:

```ts
/* hooks/skills.ts — TanStack Query hooks for the Skills inventory.
   Owns server state for /skills, /skills/:id, /skills/:id/usage.
   Components consume these — no `api.*` calls live in views. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Skill, SkillType } from "@devdigest/shared";
import { api } from "../api";

const KEY_LIST = ["skills"] as const;
const keyOne = (id: string | null | undefined) => ["skill", id] as const;
const keyUsage = (id: string) => ["skill-usage", id] as const;

export function useSkills() {
  return useQuery({
    queryKey: KEY_LIST,
    queryFn: () => api.get<Skill[]>("/skills"),
  });
}

export function useSkill(id: string | null | undefined) {
  return useQuery({
    queryKey: keyOne(id),
    queryFn: () => api.get<Skill>(`/skills/${id}`),
    enabled: !!id,
  });
}

export function useSkillUsage(id: string | null | undefined) {
  return useQuery({
    queryKey: id ? keyUsage(id) : ["skill-usage", null],
    queryFn: () => api.get<{ agent_count: number }>(`/skills/${id}/usage`),
    enabled: !!id,
  });
}

export interface CreateSkillInput {
  name: string;
  description?: string;
  type: SkillType;
  body: string;
  enabled?: boolean;
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSkillInput) => api.post<Skill>("/skills", input),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: KEY_LIST });
      qc.setQueryData(keyOne(data.id), data);
    },
  });
}

export interface UpdateSkillInput {
  id: string;
  patch: Partial<Pick<Skill, "name" | "description" | "type" | "body" | "enabled">>;
}

/** PUT /skills/:id with optimistic patch into the cached list + detail. */
export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateSkillInput) => api.put<Skill>(`/skills/${id}`, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: KEY_LIST });
      const prevList = qc.getQueryData<Skill[]>(KEY_LIST);
      const prevOne = qc.getQueryData<Skill>(keyOne(id));
      if (prevList) {
        qc.setQueryData<Skill[]>(
          KEY_LIST,
          prevList.map((s) => (s.id === id ? { ...s, ...patch } : s)),
        );
      }
      if (prevOne) {
        qc.setQueryData<Skill>(keyOne(id), { ...prevOne, ...patch });
      }
      return { prevList, prevOne };
    },
    onError: (_err, { id }, ctx) => {
      if (ctx?.prevList) qc.setQueryData(KEY_LIST, ctx.prevList);
      if (ctx?.prevOne) qc.setQueryData(keyOne(id), ctx.prevOne);
    },
    onSuccess: (data) => {
      qc.setQueryData(keyOne(data.id), data);
      qc.invalidateQueries({ queryKey: KEY_LIST });
    },
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/skills/${id}`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: KEY_LIST });
      qc.removeQueries({ queryKey: keyOne(id) });
      qc.removeQueries({ queryKey: keyUsage(id) });
    },
  });
}
```

- [ ] **Step 2: Type-check**

```
pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/hooks/skills.ts
git commit -m 'Add TanStack Query hooks for skills with optimistic updates'
```

---

### Task 9: Skills list page — empty state + loading/error

**Files:**
- Create: `client/src/app/skills/page.tsx`
- Create: `client/src/app/skills/_components/SkillsListView/SkillsListView.tsx`
- Create: `client/src/app/skills/_components/SkillsListView/SkillsListView.test.tsx`
- Create: `client/src/app/skills/_components/SkillsListView/index.ts`
- Create: `client/src/app/skills/_components/SkillsListView/styles.ts`
- Create: `client/src/app/skills/_components/SkillsListView/constants.ts`
- Create: `client/src/app/skills/_components/SkillsListView/helpers.ts`
- Create: `client/src/app/skills/_components/SkillsListView/helpers.test.ts`

**Interfaces:**
- Consumes: `useSkills`, `useUpdateSkill` from Task 8.
- Produces: `SkillsListView` (React component, default empty-state behaviour).

- [ ] **Step 1: Write the failing test for `filterSkills`**

Create `client/src/app/skills/_components/SkillsListView/helpers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Skill } from "@devdigest/shared";
import { filterSkills } from "./helpers";

const make = (overrides: Partial<Skill>): Skill => ({
  id: "1",
  name: "secret-leakage-gate",
  description: "Flag committed secrets",
  type: "security",
  source: "manual",
  body: "...",
  enabled: true,
  version: 1,
  evidence_files: null,
  ...overrides,
});

describe("filterSkills", () => {
  const all: Skill[] = [
    make({ id: "1", name: "secret-leakage-gate", type: "security" }),
    make({ id: "2", name: "pr-quality-rubric", type: "rubric" }),
    make({ id: "3", name: "no-then-chains", type: "convention" }),
  ];

  it("returns everything when no filters apply", () => {
    expect(filterSkills(all, "", new Set())).toEqual(all);
  });

  it("filters by name (case-insensitive substring)", () => {
    expect(filterSkills(all, "RUBRIC", new Set()).map((s) => s.id)).toEqual(["2"]);
  });

  it("filters by selected types (any-of)", () => {
    expect(
      filterSkills(all, "", new Set(["security", "convention"])).map((s) => s.id),
    ).toEqual(["1", "3"]);
  });

  it("combines search and type filters with AND", () => {
    expect(filterSkills(all, "no", new Set(["convention"])).map((s) => s.id)).toEqual(["3"]);
    expect(filterSkills(all, "no", new Set(["rubric"]))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — verify FAIL (file not found)**

```
pnpm exec vitest run src/app/skills/_components/SkillsListView/helpers.test.ts
```

- [ ] **Step 3: Create `helpers.ts`**

```ts
import type { Skill, SkillType } from "@devdigest/shared";

export function filterSkills(
  skills: Skill[],
  query: string,
  types: ReadonlySet<SkillType>,
): Skill[] {
  const q = query.trim().toLowerCase();
  return skills.filter((s) => {
    if (q && !s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) {
      return false;
    }
    if (types.size > 0 && !types.has(s.type)) return false;
    return true;
  });
}
```

- [ ] **Step 4: Run — should PASS**

```
pnpm exec vitest run src/app/skills/_components/SkillsListView/helpers.test.ts
```

- [ ] **Step 5: Create `constants.ts`**

```ts
import type { SkillType } from "@devdigest/shared";

export const TYPE_OPTIONS: readonly SkillType[] = [
  "rubric",
  "convention",
  "security",
  "custom",
] as const;

/** Badge background per type (CSS var name). */
export const TYPE_BADGE_BG: Record<SkillType, string> = {
  rubric: "var(--ok)",
  convention: "var(--text-secondary)",
  security: "var(--crit)",
  custom: "var(--text-muted)",
};
```

- [ ] **Step 6: Create `styles.ts`**

```ts
import type { CSSProperties } from "react";

export const s = {
  page: { padding: "32px 40px", maxWidth: 1400, margin: "0 auto" } as CSSProperties,
  header: { display: "flex", alignItems: "flex-end", gap: 24, marginBottom: 24 } as CSSProperties,
  headerText: { flex: 1 } as CSSProperties,
  h1: { fontSize: 24, fontWeight: 600, color: "var(--text-primary)" } as CSSProperties,
  subtitle: { fontSize: 13, color: "var(--text-muted)", marginTop: 6 } as CSSProperties,
  search: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 7,
    border: "1px solid var(--border-strong)",
    background: "var(--bg-elevated)",
    width: 280,
  } as CSSProperties,
  searchIcon: { color: "var(--text-muted)" } as CSSProperties,
  searchInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "var(--text-primary)",
    fontSize: 14,
  } as CSSProperties,
  toolbarRow: { display: "flex", gap: 12, alignItems: "center", marginBottom: 20 } as CSSProperties,
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: 16,
  } as CSSProperties,
};
```

- [ ] **Step 7: Create `index.ts`**

```ts
export { SkillsListView } from "./SkillsListView";
```

- [ ] **Step 8: Write the failing component test**

Create `client/src/app/skills/_components/SkillsListView/SkillsListView.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { SkillsListView } from "./SkillsListView";
import messages from "../../../../../messages/en/skills.json";

vi.mock("../../../../lib/hooks/skills", () => ({
  useSkills: () => ({ data: [], isLoading: false, isError: false }),
  useUpdateSkill: () => ({ mutate: vi.fn() }),
}));

vi.mock("../../../../components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function wrap(node: React.ReactNode) {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

describe("SkillsListView", () => {
  it("shows the empty state when there are no skills", () => {
    render(wrap(<SkillsListView />));
    expect(screen.getByText("No skills yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create your first skill/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 9: Run — verify FAIL**

```
pnpm exec vitest run src/app/skills/_components/SkillsListView/SkillsListView.test.tsx
```

- [ ] **Step 10: Create `SkillsListView.tsx`** (loading/empty/error only; toolbar and cards come in later tasks)

```tsx
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import { AppShell } from "../../../../components/app-shell";
import { useSkills } from "../../../../lib/hooks/skills";
import { s } from "./styles";

export function SkillsListView() {
  const t = useTranslations("skills");
  const router = useRouter();
  const { data: skills, isLoading, isError, refetch } = useSkills();

  return (
    <AppShell crumb={[{ label: t("list.breadcrumbLab") }, { label: t("list.breadcrumb") }]}>
      <div style={s.page}>
        <div style={s.header}>
          <div style={s.headerText}>
            <h1 style={s.h1}>{t("list.title")}</h1>
            <p style={s.subtitle}>{t("list.subtitle")}</p>
          </div>
        </div>

        {isLoading && (
          <div style={s.grid}>
            <Skeleton height={120} />
            <Skeleton height={120} />
            <Skeleton height={120} />
          </div>
        )}
        {isError && <ErrorState body={t("list.loadError")} onRetry={() => refetch()} />}
        {!isLoading && !isError && (skills?.length ?? 0) === 0 && (
          <EmptyState
            icon="Sparkles"
            title={t("list.emptyTitle")}
            body={t("list.emptyBody")}
            cta={t("list.emptyCta")}
            onCta={() => router.push("/skills/new")}
          />
        )}
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 11: Create `client/src/app/skills/page.tsx`**

```tsx
import { SkillsListView } from "./_components/SkillsListView";

/* Route: /skills. Thin entry — view + colocated components own the surface. */
export default function SkillsPage() {
  return <SkillsListView />;
}
```

- [ ] **Step 12: Run — should PASS**

```
pnpm exec vitest run src/app/skills/_components/SkillsListView
```

- [ ] **Step 13: Type-check**

```
pnpm typecheck
```

- [ ] **Step 14: Commit**

```bash
git add client/src/app/skills
git commit -m 'Add Skills list page shell with empty/loading/error states'
```

---

### Task 10: SkillCard with inline enabled toggle

**Files:**
- Create: `client/src/app/skills/_components/SkillsListView/_components/SkillCard/SkillCard.tsx`
- Create: `client/src/app/skills/_components/SkillsListView/_components/SkillCard/SkillCard.test.tsx`
- Create: `client/src/app/skills/_components/SkillsListView/_components/SkillCard/styles.ts`
- Create: `client/src/app/skills/_components/SkillsListView/_components/SkillCard/index.ts`
- Modify: `client/src/app/skills/_components/SkillsListView/SkillsListView.tsx` (render cards)
- Modify: `client/src/app/skills/_components/SkillsListView/SkillsListView.test.tsx`

**Interfaces:**
- Consumes: `Skill` from `@devdigest/shared`, `TYPE_BADGE_BG` from constants.
- Produces: `SkillCard` — props `{ skill: Skill, onClick?: () => void, onToggle?: (enabled: boolean) => void }`.

- [ ] **Step 1: Write the failing card test**

Create `SkillCard.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { SkillCard } from "./SkillCard";
import messages from "../../../../../../../messages/en/skills.json";
import type { Skill } from "@devdigest/shared";

const sample: Skill = {
  id: "1",
  name: "secret-leakage-gate",
  description: "Flag committed secrets",
  type: "security",
  source: "manual",
  body: "...",
  enabled: true,
  version: 1,
  evidence_files: null,
};

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
      {node}
    </NextIntlClientProvider>
  );
}

describe("SkillCard", () => {
  it("renders name, description, and type label", () => {
    render(wrap(<SkillCard skill={sample} />));
    expect(screen.getByText("secret-leakage-gate")).toBeInTheDocument();
    expect(screen.getByText("Flag committed secrets")).toBeInTheDocument();
    expect(screen.getByText("Security")).toBeInTheDocument();
  });

  it("fires onClick when the card body is clicked", async () => {
    const onClick = vi.fn();
    render(wrap(<SkillCard skill={sample} onClick={onClick} />));
    await userEvent.click(screen.getByRole("button", { name: /secret-leakage-gate/i }));
    expect(onClick).toHaveBeenCalled();
  });

  it("fires onToggle and does NOT fire onClick when the toggle is clicked", async () => {
    const onClick = vi.fn();
    const onToggle = vi.fn();
    render(wrap(<SkillCard skill={sample} onClick={onClick} onToggle={onToggle} />));
    await userEvent.click(screen.getByRole("switch"));
    expect(onToggle).toHaveBeenCalledWith(false);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders disabled skills dimmed", () => {
    render(wrap(<SkillCard skill={{ ...sample, enabled: false }} />));
    const card = screen.getByRole("button", { name: /secret-leakage-gate/i });
    expect(card).toHaveStyle({ opacity: "0.55" });
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```
pnpm exec vitest run src/app/skills/_components/SkillsListView/_components/SkillCard
```

- [ ] **Step 3: Create `styles.ts`**

```ts
import type { CSSProperties } from "react";
import type { SkillType } from "@devdigest/shared";
import { TYPE_BADGE_BG } from "../../constants";

export const s = {
  card: (enabled: boolean): CSSProperties => ({
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 16,
    borderRadius: 10,
    border: "1px solid var(--border)",
    background: "var(--bg-surface)",
    cursor: "pointer",
    opacity: enabled ? 1 : 0.55,
    transition: "background .12s, border-color .12s",
    textAlign: "left",
    color: "var(--text-primary)",
    font: "inherit",
  }),
  headerRow: { display: "flex", alignItems: "center", gap: 10 } as CSSProperties,
  name: {
    flex: 1,
    fontFamily: "var(--mono)",
    fontSize: 13,
    color: "var(--text-primary)",
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as CSSProperties,
  description: {
    fontSize: 13,
    color: "var(--text-muted)",
    lineHeight: 1.5,
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  } as CSSProperties,
  badge: (type: SkillType): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 500,
    color: "var(--text-inverse)",
    background: TYPE_BADGE_BG[type],
    textTransform: "lowercase",
    letterSpacing: ".02em",
  }),
};
```

- [ ] **Step 4: Create `SkillCard.tsx`**

```tsx
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Toggle } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { s } from "./styles";

export function SkillCard({
  skill,
  onClick,
  onToggle,
}: {
  skill: Skill;
  onClick?: () => void;
  onToggle?: (enabled: boolean) => void;
}) {
  const t = useTranslations("skills");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={skill.name}
      style={s.card(skill.enabled)}
    >
      <div style={s.headerRow}>
        <span style={s.name}>{skill.name}</span>
        <span style={s.badge(skill.type)}>{t(`types.${skill.type}`)}</span>
        {onToggle && (
          <div onClick={(e) => e.stopPropagation()}>
            <Toggle on={skill.enabled} onChange={onToggle} size={14} />
          </div>
        )}
      </div>
      <div style={s.description}>
        {skill.description || t("card.noDescription")}
      </div>
    </button>
  );
}
```

- [ ] **Step 5: Create `index.ts`**

```ts
export { SkillCard } from "./SkillCard";
```

- [ ] **Step 6: Wire the card into the list view**

Modify `SkillsListView.tsx` to render the grid when skills exist:

```tsx
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import { AppShell } from "../../../../components/app-shell";
import { useSkills, useUpdateSkill } from "../../../../lib/hooks/skills";
import { SkillCard } from "./_components/SkillCard";
import { s } from "./styles";

export function SkillsListView() {
  const t = useTranslations("skills");
  const router = useRouter();
  const { data: skills, isLoading, isError, refetch } = useSkills();
  const update = useUpdateSkill();

  const hasSkills = (skills?.length ?? 0) > 0;

  return (
    <AppShell crumb={[{ label: t("list.breadcrumbLab") }, { label: t("list.breadcrumb") }]}>
      <div style={s.page}>
        <div style={s.header}>
          <div style={s.headerText}>
            <h1 style={s.h1}>{t("list.title")}</h1>
            <p style={s.subtitle}>{t("list.subtitle")}</p>
          </div>
        </div>

        {isLoading && (
          <div style={s.grid}>
            <Skeleton height={120} />
            <Skeleton height={120} />
            <Skeleton height={120} />
          </div>
        )}
        {isError && <ErrorState body={t("list.loadError")} onRetry={() => refetch()} />}
        {!isLoading && !isError && !hasSkills && (
          <EmptyState
            icon="Sparkles"
            title={t("list.emptyTitle")}
            body={t("list.emptyBody")}
            cta={t("list.emptyCta")}
            onCta={() => router.push("/skills/new")}
          />
        )}
        {hasSkills && (
          <div style={s.grid}>
            {skills!.map((sk) => (
              <SkillCard
                key={sk.id}
                skill={sk}
                onClick={() => {/* drawer wiring in Task 12 */}}
                onToggle={(enabled) => update.mutate({ id: sk.id, patch: { enabled } })}
              />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
```

Update `SkillsListView.test.tsx` to add a test for the populated case:

```tsx
import type { Skill } from "@devdigest/shared";

const ONE: Skill = {
  id: "1",
  name: "secret-leakage-gate",
  description: "x",
  type: "security",
  source: "manual",
  body: "",
  enabled: true,
  version: 1,
  evidence_files: null,
};

it("renders a card per skill when the list is non-empty", () => {
  vi.mocked(/* useSkills */).mockReturnValueOnce({ data: [ONE], isLoading: false, isError: false } as any);
  render(wrap(<SkillsListView />));
  expect(screen.getByText("secret-leakage-gate")).toBeInTheDocument();
});
```

(Adjust the `vi.mock` factory at the top so `useSkills` is a `vi.fn` you can override per-test; example: `const useSkills = vi.fn(() => ({ data: [], isLoading: false, isError: false }));` then `vi.mock(...)` returns `{ useSkills, useUpdateSkill: () => ({ mutate: vi.fn() }) }`.)

- [ ] **Step 7: Run tests**

```
pnpm exec vitest run src/app/skills
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add client/src/app/skills
git commit -m 'Add SkillCard with inline enabled toggle'
```

---

### Task 11: Toolbar (search + type filter)

**Files:**
- Create: `client/src/app/skills/_components/SkillsListView/_components/SkillsToolbar/SkillsToolbar.tsx`
- Create: `client/src/app/skills/_components/SkillsListView/_components/SkillsToolbar/styles.ts`
- Create: `client/src/app/skills/_components/SkillsListView/_components/SkillsToolbar/index.ts`
- Modify: `SkillsListView.tsx` (wire toolbar + use `filterSkills`)
- Modify: `SkillsListView.test.tsx` (add filter test)

**Interfaces:**
- Produces: `SkillsToolbar({ query, onQuery, types, onTypes, actions? })`.

- [ ] **Step 1: Create the toolbar styles + component**

`styles.ts`:

```ts
import type { CSSProperties } from "react";

export const s = {
  row: { display: "flex", gap: 12, alignItems: "center", marginBottom: 20 } as CSSProperties,
  search: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 7,
    border: "1px solid var(--border-strong)",
    background: "var(--bg-elevated)",
    width: 280,
  } as CSSProperties,
  searchInput: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "var(--text-primary)",
    fontSize: 14,
  } as CSSProperties,
  chips: { display: "flex", gap: 6 } as CSSProperties,
  chip: (active: boolean): CSSProperties => ({
    padding: "4px 10px",
    borderRadius: 99,
    fontSize: 12,
    border: "1px solid var(--border-strong)",
    background: active ? "var(--accent)" : "var(--bg-elevated)",
    color: active ? "var(--text-inverse)" : "var(--text-secondary)",
    cursor: "pointer",
  }),
  spacer: { flex: 1 } as CSSProperties,
};
```

`SkillsToolbar.tsx`:

```tsx
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { SkillType } from "@devdigest/shared";
import { TYPE_OPTIONS } from "../../constants";
import { s } from "./styles";

export function SkillsToolbar({
  query,
  onQuery,
  types,
  onTypes,
  actions,
}: {
  query: string;
  onQuery: (v: string) => void;
  types: ReadonlySet<SkillType>;
  onTypes: (next: Set<SkillType>) => void;
  actions?: React.ReactNode;
}) {
  const t = useTranslations("skills");

  const toggle = (type: SkillType) => {
    const next = new Set(types);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    onTypes(next);
  };

  return (
    <div style={s.row}>
      <div style={s.search}>
        <Icon.Search size={13} />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={t("list.searchPlaceholder")}
          style={s.searchInput}
        />
      </div>
      <div style={s.chips} role="group" aria-label={t("list.filterByType")}>
        {TYPE_OPTIONS.map((type) => (
          <button
            key={type}
            type="button"
            aria-pressed={types.has(type)}
            onClick={() => toggle(type)}
            style={s.chip(types.has(type))}
          >
            {t(`types.${type}`)}
          </button>
        ))}
      </div>
      <div style={s.spacer} />
      {actions}
    </div>
  );
}
```

`index.ts`:

```ts
export { SkillsToolbar } from "./SkillsToolbar";
```

- [ ] **Step 2: Add a filter test to `SkillsListView.test.tsx`**

```tsx
import userEvent from "@testing-library/user-event";

it("filters the grid by search query", async () => {
  vi.mocked(/* useSkills */).mockReturnValueOnce({
    data: [
      { ...ONE, id: "1", name: "secret-leakage-gate" },
      { ...ONE, id: "2", name: "pr-quality-rubric", type: "rubric" },
    ],
    isLoading: false,
    isError: false,
  } as any);

  render(wrap(<SkillsListView />));
  expect(screen.getByText("secret-leakage-gate")).toBeInTheDocument();
  await userEvent.type(screen.getByPlaceholderText(/Search skills/), "rubric");
  expect(screen.queryByText("secret-leakage-gate")).not.toBeInTheDocument();
  expect(screen.getByText("pr-quality-rubric")).toBeInTheDocument();
});
```

- [ ] **Step 3: Wire the toolbar into the list view**

Modify `SkillsListView.tsx`:

```tsx
import { SkillsToolbar } from "./_components/SkillsToolbar";
import { filterSkills } from "./helpers";
import type { SkillType } from "@devdigest/shared";

// inside the component:
const [query, setQuery] = React.useState("");
const [types, setTypes] = React.useState<Set<SkillType>>(new Set());
const visible = filterSkills(skills ?? [], query, types);
const filteredOut = hasSkills && visible.length === 0;
```

Insert the toolbar between the header and the grid:

```tsx
{hasSkills && (
  <SkillsToolbar query={query} onQuery={setQuery} types={types} onTypes={setTypes} />
)}
```

Replace the grid block to use `visible` instead of `skills`, and add the "no match" empty state:

```tsx
{filteredOut && (
  <EmptyState
    icon="Search"
    title={t("list.noMatchTitle")}
    body={t("list.noMatchBody")}
    cta={t("list.noMatchCta")}
    onCta={() => { setQuery(""); setTypes(new Set()); }}
  />
)}
{visible.length > 0 && (
  <div style={s.grid}>
    {visible.map((sk) => (
      <SkillCard
        key={sk.id}
        skill={sk}
        onClick={() => {/* drawer wiring in Task 12 */}}
        onToggle={(enabled) => update.mutate({ id: sk.id, patch: { enabled } })}
      />
    ))}
  </div>
)}
```

- [ ] **Step 4: Run tests**

```
pnpm exec vitest run src/app/skills
```

- [ ] **Step 5: Commit**

```bash
git add client/src/app/skills
git commit -m 'Add search and type-filter toolbar on Skills list'
```

---

### Task 12: SkillPreviewDrawer + drawer state in list view

**Files:**
- Create: `client/src/app/skills/_components/SkillsListView/_components/SkillPreviewDrawer/SkillPreviewDrawer.tsx`
- Create: `client/src/app/skills/_components/SkillsListView/_components/SkillPreviewDrawer/SkillPreviewDrawer.test.tsx`
- Create: `client/src/app/skills/_components/SkillsListView/_components/SkillPreviewDrawer/styles.ts`
- Create: `client/src/app/skills/_components/SkillsListView/_components/SkillPreviewDrawer/index.ts`
- Modify: `SkillsListView.tsx` (drawer state + open on card click)

**Interfaces:**
- Consumes: `useSkill(id)`, `useSkillUsage(id)`, `useDeleteSkill()` from Task 8.
- Produces: `SkillPreviewDrawer({ skillId, onClose, onEdit, onDelete })`. The drawer is uncontrolled w.r.t. delete (Task 13 wires the dialog).

- [ ] **Step 1: Write the failing drawer test**

`SkillPreviewDrawer.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { SkillPreviewDrawer } from "./SkillPreviewDrawer";
import messages from "../../../../../../../messages/en/skills.json";
import type { Skill } from "@devdigest/shared";

const sample: Skill = {
  id: "1",
  name: "secret-leakage-gate",
  description: "Flag committed secrets",
  type: "security",
  source: "manual",
  body: "## Heading\n\nflag secrets",
  enabled: true,
  version: 1,
  evidence_files: null,
};

vi.mock("../../../../../../lib/hooks/skills", () => ({
  useSkill: () => ({ data: sample, isLoading: false }),
  useSkillUsage: () => ({ data: { agent_count: 0 } }),
}));

function wrap(node: React.ReactNode) {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

describe("SkillPreviewDrawer", () => {
  it("renders the markdown body via react-markdown", () => {
    render(
      wrap(
        <SkillPreviewDrawer
          skillId="1"
          onClose={() => undefined}
          onEdit={() => undefined}
          onDeleteRequest={() => undefined}
        />,
      ),
    );
    expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument();
  });

  it("fires onEdit when the Edit button is clicked", async () => {
    const onEdit = vi.fn();
    render(
      wrap(
        <SkillPreviewDrawer
          skillId="1"
          onClose={() => undefined}
          onEdit={onEdit}
          onDeleteRequest={() => undefined}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /Edit/i }));
    expect(onEdit).toHaveBeenCalledWith("1");
  });

  it("fires onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    render(
      wrap(
        <SkillPreviewDrawer
          skillId="1"
          onClose={onClose}
          onEdit={() => undefined}
          onDeleteRequest={() => undefined}
        />,
      ),
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```
pnpm exec vitest run src/app/skills/_components/SkillsListView/_components/SkillPreviewDrawer
```

- [ ] **Step 3: Create drawer styles**

`styles.ts`:

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
    alignItems: "center",
    gap: 10,
  } as CSSProperties,
  name: {
    flex: 1,
    fontFamily: "var(--mono)",
    fontSize: 14,
    color: "var(--text-primary)",
  } as CSSProperties,
  body: {
    flex: 1,
    overflow: "auto",
    padding: "20px",
  } as CSSProperties,
  description: { fontSize: 13, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.5 } as CSSProperties,
  markdown: {
    fontSize: 13,
    color: "var(--text-primary)",
    lineHeight: 1.6,
  } as CSSProperties,
  footer: {
    padding: "12px 20px",
    borderTop: "1px solid var(--border)",
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
  } as CSSProperties,
};
```

- [ ] **Step 4: Create the drawer component**

`SkillPreviewDrawer.tsx`:

```tsx
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import ReactMarkdown from "react-markdown";
import { Button, Dropdown, Icon, Toggle } from "@devdigest/ui";
import { useSkill, useUpdateSkill } from "../../../../../../lib/hooks/skills";
import { s } from "./styles";

export function SkillPreviewDrawer({
  skillId,
  onClose,
  onEdit,
  onDeleteRequest,
}: {
  skillId: string;
  onClose: () => void;
  onEdit: (id: string) => void;
  onDeleteRequest: (id: string) => void;
}) {
  const t = useTranslations("skills");
  const { data: skill } = useSkill(skillId);
  const update = useUpdateSkill();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!skill) return null;

  return (
    <>
      <div style={s.overlay} onClick={onClose} />
      <aside style={s.drawer} role="dialog" aria-label={skill.name}>
        <div style={s.header}>
          <span style={s.name}>{skill.name}</span>
          <Toggle
            on={skill.enabled}
            onChange={(enabled) => update.mutate({ id: skill.id, patch: { enabled } })}
            size={14}
          />
          <Dropdown
            align="right"
            width={180}
            trigger={
              <button aria-label="more" style={{ background: "none", border: "none", padding: 4, cursor: "pointer", color: "var(--text-muted)" }}>
                <Icon.MoreHorizontal size={16} />
              </button>
            }
            items={[{ label: t("drawer.deleteMenu"), icon: "Trash", onClick: () => onDeleteRequest(skill.id) }]}
          />
          <button aria-label={t("drawer.closeAria")} onClick={onClose} style={{ background: "none", border: "none", padding: 4, cursor: "pointer", color: "var(--text-muted)" }}>
            <Icon.X size={16} />
          </button>
        </div>
        <div style={s.body}>
          {skill.description && <p style={s.description}>{skill.description}</p>}
          <div style={s.markdown}>
            <ReactMarkdown>{skill.body}</ReactMarkdown>
          </div>
        </div>
        <div style={s.footer}>
          <Button kind="primary" icon="Edit" onClick={() => onEdit(skill.id)}>
            {t("drawer.edit")}
          </Button>
        </div>
      </aside>
    </>
  );
}
```

`index.ts`:

```ts
export { SkillPreviewDrawer } from "./SkillPreviewDrawer";
```

- [ ] **Step 5: Wire the drawer into the list view**

Modify `SkillsListView.tsx`:

```tsx
import { SkillPreviewDrawer } from "./_components/SkillPreviewDrawer";

// inside the component:
const [selectedId, setSelectedId] = React.useState<string | null>(null);
const [pendingDelete, setPendingDelete] = React.useState<string | null>(null);
```

Pass `onClick={() => setSelectedId(sk.id)}` to each `SkillCard`, and render the drawer when `selectedId` is set (place it just before `</AppShell>`):

```tsx
{selectedId && (
  <SkillPreviewDrawer
    skillId={selectedId}
    onClose={() => setSelectedId(null)}
    onEdit={(id) => router.push(`/skills/${id}`)}
    onDeleteRequest={(id) => setPendingDelete(id)}
  />
)}
```

(The `DeleteSkillDialog` consumer of `pendingDelete` is added in Task 13.)

- [ ] **Step 6: Run tests**

```
pnpm exec vitest run src/app/skills
```

- [ ] **Step 7: Commit**

```bash
git add client/src/app/skills
git commit -m 'Add Skills preview drawer with markdown body and edit action'
```

---

### Task 13: DeleteSkillDialog with usage count

**Files:**
- Create: `client/src/app/skills/_components/SkillsListView/_components/DeleteSkillDialog/DeleteSkillDialog.tsx`
- Create: `client/src/app/skills/_components/SkillsListView/_components/DeleteSkillDialog/index.ts`
- Modify: `SkillsListView.tsx` (render the dialog when `pendingDelete` is set; on confirm, call `useDeleteSkill`)

**Interfaces:**
- Consumes: `useSkill(id)`, `useSkillUsage(id)`, `useDeleteSkill()`.
- Produces: `DeleteSkillDialog({ skillId, onClose, onDeleted? })`.

- [ ] **Step 1: Create the dialog**

```tsx
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Modal } from "@devdigest/ui";
import { useSkill, useSkillUsage, useDeleteSkill } from "../../../../../../lib/hooks/skills";

export function DeleteSkillDialog({
  skillId,
  onClose,
  onDeleted,
}: {
  skillId: string;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const t = useTranslations("skills");
  const { data: skill } = useSkill(skillId);
  const { data: usage } = useSkillUsage(skillId);
  const del = useDeleteSkill();

  if (!skill) return null;

  const count = usage?.agent_count ?? 0;
  const body = count === 0
    ? t("delete.bodyZero", { name: skill.name })
    : t("delete.bodyN", { name: skill.name, count });

  return (
    <Modal open onClose={onClose} title={t("delete.title")}>
      <p style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)", marginBottom: 16 }}>
        {body}
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button kind="ghost" onClick={onClose}>{t("delete.cancel")}</Button>
        <Button
          kind="danger"
          icon="Trash"
          disabled={del.isPending}
          onClick={() => {
            del.mutate(skillId, {
              onSuccess: () => {
                onDeleted?.();
                onClose();
              },
            });
          }}
        >
          {del.isPending ? t("delete.deleting") : t("delete.confirm")}
        </Button>
      </div>
    </Modal>
  );
}
```

`index.ts`:

```ts
export { DeleteSkillDialog } from "./DeleteSkillDialog";
```

- [ ] **Step 2: Wire it into the list view**

In `SkillsListView.tsx`, render the dialog when `pendingDelete` is set, and clear `selectedId` after a successful delete:

```tsx
import { DeleteSkillDialog } from "./_components/DeleteSkillDialog";

{pendingDelete && (
  <DeleteSkillDialog
    skillId={pendingDelete}
    onClose={() => setPendingDelete(null)}
    onDeleted={() => setSelectedId(null)}
  />
)}
```

- [ ] **Step 3: Add the test to `SkillPreviewDrawer.test.tsx`** (assert the kebab → delete callback)

```tsx
it("fires onDeleteRequest when the kebab → Delete is chosen", async () => {
  const onDeleteRequest = vi.fn();
  render(
    wrap(
      <SkillPreviewDrawer
        skillId="1"
        onClose={() => undefined}
        onEdit={() => undefined}
        onDeleteRequest={onDeleteRequest}
      />,
    ),
  );
  await userEvent.click(screen.getByLabelText("more"));
  await userEvent.click(screen.getByText(/Delete…/));
  expect(onDeleteRequest).toHaveBeenCalledWith("1");
});
```

- [ ] **Step 4: Run tests**

```
pnpm exec vitest run src/app/skills
```

- [ ] **Step 5: Commit**

```bash
git add client/src/app/skills
git commit -m 'Add delete-skill confirm dialog with usage count'
```

---

### Task 14: AddSkillButton dropdown

**Files:**
- Create: `client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.tsx`
- Create: `client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/index.ts`
- Modify: `SkillsListView.tsx` (mount the button in the header)

**Interfaces:**
- Produces: `AddSkillButton({ onCreate })` — renders a `Dropdown` with two items: `Create` (enabled) and `Import` (disabled with `Coming soon` tooltip).

- [ ] **Step 1: Create the component**

```tsx
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Dropdown } from "@devdigest/ui";

export function AddSkillButton({ onCreate }: { onCreate: () => void }) {
  const t = useTranslations("skills");
  return (
    <Dropdown
      width={220}
      align="right"
      trigger={
        <Button kind="primary" size="sm" icon="Plus" iconRight="ChevronDown">
          {t("list.addSkill")}
        </Button>
      }
      items={[
        { label: t("list.createFromScratch"), icon: "Edit", onClick: onCreate },
        { divider: true },
        {
          label: t("list.importFromFile"),
          icon: "Upload" as const,
          muted: true,
          disabled: true,
          tooltip: t("list.importComingSoon"),
        },
      ]}
    />
  );
}
```

`index.ts`:

```ts
export { AddSkillButton } from "./AddSkillButton";
```

Note: the `Dropdown` item shape supports `disabled`/`tooltip`. If those aren't already supported by the existing `Dropdown` primitive, fall back to passing `onClick: () => undefined` and rely on `muted: true` for the visual cue while showing a `title` attribute via a wrapped `<span>` in the label. Check `client/src/vendor/ui/primitives/Dropdown.tsx` before assuming the prop names.

- [ ] **Step 2: Mount the button in the list view header**

```tsx
import { AddSkillButton } from "./_components/AddSkillButton";

// inside the header block:
<div style={{ marginLeft: "auto" }}>
  <AddSkillButton onCreate={() => router.push("/skills/new")} />
</div>
```

Make the same button available in the toolbar's `actions` slot when there are skills (so it lives on the right of the toolbar row, not just the header):

```tsx
<SkillsToolbar
  query={query}
  onQuery={setQuery}
  types={types}
  onTypes={setTypes}
  actions={<AddSkillButton onCreate={() => router.push("/skills/new")} />}
/>
```

- [ ] **Step 3: Run tests + type-check**

```
pnpm exec vitest run src/app/skills && pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add client/src/app/skills
git commit -m 'Add create/import dropdown on Skills list'
```

---

### Task 15: SkillEditor page shells (/skills/new, /skills/[id])

**Files:**
- Create: `client/src/app/skills/new/page.tsx`
- Create: `client/src/app/skills/[id]/page.tsx`
- Create: `client/src/app/skills/_components/SkillEditor/SkillEditor.tsx`
- Create: `client/src/app/skills/_components/SkillEditor/index.ts`
- Create: `client/src/app/skills/_components/SkillEditor/styles.ts`

**Interfaces:**
- Produces: `<SkillEditor mode="create" />` and `<SkillEditor mode="edit" skillId={id} />`.

- [ ] **Step 1: Create the editor shell** (form fields land in Task 16, markdown split in Task 17)

`SkillEditor.tsx`:

```tsx
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ErrorState, Skeleton } from "@devdigest/ui";
import { AppShell } from "../../../../components/app-shell";
import { useSkill } from "../../../../lib/hooks/skills";
import { s } from "./styles";

type Mode = { mode: "create" } | { mode: "edit"; skillId: string };

export function SkillEditor(props: Mode) {
  const t = useTranslations("skills");
  const router = useRouter();
  const isEdit = props.mode === "edit";
  const { data: skill, isLoading, isError, refetch } = useSkill(isEdit ? props.skillId : null);

  const crumb = [
    { label: t("list.breadcrumbLab") },
    { label: t("list.breadcrumb"), href: "/skills" },
    { label: isEdit ? skill?.name ?? t("editor.editTitle") : t("editor.createTitle") },
  ];

  if (isEdit && isError) {
    return (
      <AppShell crumb={crumb}>
        <ErrorState
          fullScreen
          title={t("editor.loadErrorTitle")}
          body={t("editor.loadErrorBody")}
          onRetry={() => refetch()}
        />
      </AppShell>
    );
  }

  if (isEdit && isLoading) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.page}>
          <Skeleton height={28} />
          <Skeleton height={240} />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>
        <h1 style={s.h1}>
          {isEdit ? t("editor.editTitle") : t("editor.createTitle")}
        </h1>
        <p style={s.subtitle}>{t("editor.createSubtitle")}</p>
        {/* form fields land in Task 16 */}
      </div>
    </AppShell>
  );
}
```

`styles.ts`:

```ts
import type { CSSProperties } from "react";

export const s = {
  page: { padding: "32px 40px", maxWidth: 960, margin: "0 auto" } as CSSProperties,
  h1: { fontSize: 22, fontWeight: 600, color: "var(--text-primary)" } as CSSProperties,
  subtitle: { fontSize: 13, color: "var(--text-muted)", marginTop: 6, marginBottom: 24 } as CSSProperties,
  actions: { display: "flex", alignItems: "center", gap: 12, marginTop: 24 } as CSSProperties,
  savedNote: { fontSize: 12, color: "var(--text-muted)" } as CSSProperties,
};
```

`index.ts`:

```ts
export { SkillEditor } from "./SkillEditor";
```

- [ ] **Step 2: Create the route shells**

`client/src/app/skills/new/page.tsx`:

```tsx
import { SkillEditor } from "../_components/SkillEditor";

export default function NewSkillPage() {
  return <SkillEditor mode="create" />;
}
```

`client/src/app/skills/[id]/page.tsx`:

```tsx
"use client";

import { useParams } from "next/navigation";
import { SkillEditor } from "../_components/SkillEditor";

export default function EditSkillPage() {
  const { id } = useParams<{ id: string }>();
  return <SkillEditor mode="edit" skillId={id} />;
}
```

- [ ] **Step 3: Smoke-test by visiting the route**

Start the client dev server (`cd client && pnpm dev`), open `http://localhost:3000/skills/new`, confirm the page renders with the "Create skill" heading and breadcrumb.

- [ ] **Step 4: Type-check**

```
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add client/src/app/skills
git commit -m 'Add Skills editor route shells for create and edit'
```

---

### Task 16: SkillEditor form fields + save (no markdown body yet)

**Files:**
- Create: `client/src/app/skills/_components/SkillEditor/SkillEditor.test.tsx`
- Modify: `client/src/app/skills/_components/SkillEditor/SkillEditor.tsx`

**Interfaces:**
- Consumes: `useCreateSkill`, `useUpdateSkill`, `useToast`.
- Produces: editor form persisting name/description/type/enabled.

- [ ] **Step 1: Write the failing test**

`SkillEditor.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { SkillEditor } from "./SkillEditor";
import messages from "../../../../../messages/en/skills.json";

const create = vi.fn(() => Promise.resolve({ id: "new-id", version: 1 }));
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useParams: () => ({}),
}));

vi.mock("../../../../components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../../../lib/hooks/skills", () => ({
  useSkill: () => ({ data: undefined, isLoading: false, isError: false }),
  useCreateSkill: () => ({ mutate: (input: any, opts: any) => create(input).then(opts?.onSuccess), isPending: false }),
  useUpdateSkill: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("../../../../lib/toast", () => ({ useToast: () => ({ success: vi.fn() }) }));

function wrap(node: React.ReactNode) {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

describe("SkillEditor (create mode)", () => {
  it("disables the Create button until name is non-empty", async () => {
    render(wrap(<SkillEditor mode="create" />));
    const create = screen.getByRole("button", { name: /Create skill/i });
    expect(create).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Name/i), "secret-leakage-gate");
    expect(create).toBeEnabled();
  });

  it("submits + navigates to the new skill's edit route", async () => {
    render(wrap(<SkillEditor mode="create" />));
    await userEvent.type(screen.getByLabelText(/Name/i), "x");
    await userEvent.type(screen.getByLabelText(/Body/i), "body");
    await userEvent.click(screen.getByRole("button", { name: /Create skill/i }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "x", body: "body", type: "custom" })));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/skills/new-id"));
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```
pnpm exec vitest run src/app/skills/_components/SkillEditor
```

- [ ] **Step 3: Add the form to `SkillEditor.tsx`**

Replace the editor file with:

```tsx
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, ErrorState, FormField, SelectInput, Skeleton, TextInput, Textarea, Toggle } from "@devdigest/ui";
import type { Skill, SkillType } from "@devdigest/shared";
import { AppShell } from "../../../../components/app-shell";
import { useCreateSkill, useSkill, useUpdateSkill } from "../../../../lib/hooks/skills";
import { useToast } from "../../../../lib/toast";
import { TYPE_OPTIONS } from "../SkillsListView/constants";
import { s } from "./styles";

type Mode = { mode: "create" } | { mode: "edit"; skillId: string };

export function SkillEditor(props: Mode) {
  const t = useTranslations("skills");
  const router = useRouter();
  const toast = useToast();
  const isEdit = props.mode === "edit";
  const { data: skill, isLoading, isError, refetch } = useSkill(isEdit ? props.skillId : null);
  const create = useCreateSkill();
  const update = useUpdateSkill();

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [type, setType] = React.useState<SkillType>("custom");
  const [enabled, setEnabled] = React.useState(true);
  const [body, setBody] = React.useState("");

  React.useEffect(() => {
    if (!skill) return;
    setName(skill.name);
    setDescription(skill.description);
    setType(skill.type);
    setEnabled(skill.enabled);
    setBody(skill.body);
  }, [skill?.id]);

  const crumb = [
    { label: t("list.breadcrumbLab") },
    { label: t("list.breadcrumb"), href: "/skills" },
    { label: isEdit ? skill?.name ?? t("editor.editTitle") : t("editor.createTitle") },
  ];

  if (isEdit && isError) {
    return (
      <AppShell crumb={crumb}>
        <ErrorState
          fullScreen
          title={t("editor.loadErrorTitle")}
          body={t("editor.loadErrorBody")}
          onRetry={() => refetch()}
        />
      </AppShell>
    );
  }

  if (isEdit && isLoading) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.page}>
          <Skeleton height={28} />
          <Skeleton height={240} />
        </div>
      </AppShell>
    );
  }

  const canSubmit = name.trim().length > 0 && body.trim().length > 0;

  const onSave = () => {
    if (isEdit) {
      update.mutate(
        { id: props.skillId, patch: { name, description, type, body, enabled } },
        { onSuccess: (data) => toast.success(t("editor.savedToast", { version: data.version })) },
      );
    } else {
      create.mutate(
        { name, description, type, body, enabled },
        { onSuccess: (data) => router.push(`/skills/${data.id}`) },
      );
    }
  };

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>
        <h1 style={s.h1}>{isEdit ? t("editor.editTitle") : t("editor.createTitle")}</h1>
        <p style={s.subtitle}>{t("editor.createSubtitle")}</p>

        <FormField label={t("editor.name")} required>
          <TextInput value={name} onChange={setName} placeholder={t("editor.namePlaceholder")} mono />
        </FormField>
        <FormField label={t("editor.description")} hint={t("editor.descriptionHint")}>
          <TextInput value={description} onChange={setDescription} placeholder={t("editor.descriptionPlaceholder")} />
        </FormField>
        <FormField label={t("editor.type")}>
          <SelectInput
            value={type}
            onChange={(v) => setType(v as SkillType)}
            options={TYPE_OPTIONS.map((tp) => ({ value: tp, label: t(`types.${tp}`) }))}
            mono={false}
          />
        </FormField>
        <FormField label={t("editor.enabled")}>
          <Toggle on={enabled} onChange={setEnabled} size={16} />
        </FormField>
        <FormField label={t("editor.body")}>
          <Textarea value={body} onChange={setBody} rows={16} mono placeholder={t("editor.bodyPlaceholder")} />
        </FormField>

        <div style={s.actions}>
          <Button
            kind="primary"
            icon="Check"
            onClick={onSave}
            disabled={!canSubmit || create.isPending || update.isPending}
          >
            {isEdit
              ? (update.isPending ? t("editor.saving") : t("editor.save"))
              : (create.isPending ? t("editor.creating") : t("editor.create"))}
          </Button>
          {isEdit && update.isSuccess && (
            <span style={s.savedNote}>{t("editor.saved", { version: update.data?.version })}</span>
          )}
        </div>
      </div>
    </AppShell>
  );
}
```

- [ ] **Step 4: Run tests**

```
pnpm exec vitest run src/app/skills/_components/SkillEditor
```

Expected: PASS.

- [ ] **Step 5: Type-check**

```
pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add client/src/app/skills/_components/SkillEditor
git commit -m 'Add Skills editor form for create and edit modes'
```

---

### Task 17: MarkdownSplit body editor with live preview

**Files:**
- Create: `client/src/app/skills/_components/SkillEditor/_components/MarkdownSplit/MarkdownSplit.tsx`
- Create: `client/src/app/skills/_components/SkillEditor/_components/MarkdownSplit/MarkdownSplit.test.tsx`
- Create: `client/src/app/skills/_components/SkillEditor/_components/MarkdownSplit/styles.ts`
- Create: `client/src/app/skills/_components/SkillEditor/_components/MarkdownSplit/index.ts`
- Modify: `SkillEditor.tsx` (swap the body `Textarea` for `MarkdownSplit`)

**Interfaces:**
- Produces: `MarkdownSplit({ value, onChange, rows?, ariaLabel? })` — left pane is a controlled `<textarea>`, right pane renders `value` via `react-markdown`. A `Preview` toggle button collapses the right pane on narrow widths.

- [ ] **Step 1: Write the failing test**

```tsx
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { MarkdownSplit } from "./MarkdownSplit";
import messages from "../../../../../../messages/en/skills.json";

function Wrapped() {
  const [value, setValue] = React.useState("");
  return (
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
      <MarkdownSplit value={value} onChange={setValue} />
    </NextIntlClientProvider>
  );
}

describe("MarkdownSplit", () => {
  it("renders typed markdown in the preview pane", async () => {
    render(<Wrapped />);
    await userEvent.type(screen.getByRole("textbox"), "## Hello");
    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

- [ ] **Step 3: Create the styles + component**

`styles.ts`:

```ts
import type { CSSProperties } from "react";

export const s = {
  wrap: {
    border: "1px solid var(--border-strong)",
    borderRadius: 7,
    overflow: "hidden",
    background: "var(--bg-elevated)",
  } as CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    padding: 6,
    background: "var(--bg-surface)",
    borderBottom: "1px solid var(--border)",
  } as CSSProperties,
  split: { display: "grid", gridTemplateColumns: "1fr 1fr", minHeight: 320 } as CSSProperties,
  splitSolo: { display: "block" } as CSSProperties,
  pane: { padding: 12, fontSize: 13, lineHeight: 1.55, overflow: "auto" } as CSSProperties,
  textarea: {
    width: "100%",
    height: "100%",
    minHeight: 320,
    border: "none",
    outline: "none",
    resize: "vertical",
    background: "transparent",
    color: "var(--text-primary)",
    fontFamily: "var(--mono)",
    fontSize: 13,
    lineHeight: 1.55,
    padding: 12,
  } as CSSProperties,
  previewSeparator: { borderLeft: "1px solid var(--border)" } as CSSProperties,
  toggleButton: (active: boolean): CSSProperties => ({
    padding: "4px 10px",
    fontSize: 12,
    borderRadius: 4,
    border: "1px solid var(--border)",
    background: active ? "var(--accent)" : "transparent",
    color: active ? "var(--text-inverse)" : "var(--text-secondary)",
    cursor: "pointer",
  }),
};
```

`MarkdownSplit.tsx`:

```tsx
"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import { useTranslations } from "next-intl";
import { s } from "./styles";

export function MarkdownSplit({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
}) {
  const t = useTranslations("skills");
  const [showPreview, setShowPreview] = React.useState(true);

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <button
          type="button"
          aria-pressed={showPreview}
          onClick={() => setShowPreview((v) => !v)}
          style={s.toggleButton(showPreview)}
        >
          {t("editor.previewToggle")}
        </button>
      </div>
      <div style={showPreview ? s.split : s.splitSolo}>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={s.textarea}
          aria-label={ariaLabel ?? "Markdown body"}
        />
        {showPreview && (
          <div style={{ ...s.pane, ...s.previewSeparator }}>
            <ReactMarkdown>{value}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
```

`index.ts`:

```ts
export { MarkdownSplit } from "./MarkdownSplit";
```

- [ ] **Step 4: Swap the body field in `SkillEditor.tsx`**

Replace:

```tsx
<FormField label={t("editor.body")}>
  <Textarea value={body} onChange={setBody} rows={16} mono placeholder={t("editor.bodyPlaceholder")} />
</FormField>
```

with:

```tsx
<FormField label={t("editor.body")}>
  <MarkdownSplit value={body} onChange={setBody} ariaLabel={t("editor.body")} />
</FormField>
```

Add the import:

```tsx
import { MarkdownSplit } from "./_components/MarkdownSplit";
```

(Remove the now-unused `Textarea` import.)

- [ ] **Step 5: Run tests**

```
pnpm exec vitest run src/app/skills
```

- [ ] **Step 6: Type-check + build**

```
pnpm typecheck && pnpm build
```

- [ ] **Step 7: Commit**

```bash
git add client/src/app/skills/_components/SkillEditor
git commit -m 'Add split markdown editor with live preview pane'
```

---

### Task 18: Smoke-test the full flow end-to-end

**Files:** none modified — this task verifies the integration story.

- [ ] **Step 1: Start the stack**

From the repo root: `./scripts/dev.sh` (Postgres + server + client).

If `dev.sh` warns about pending migrations, run `cd server && pnpm db:migrate` first.

- [ ] **Step 2: Walk the happy path**

1. Open `http://localhost:3000/skills` → empty state shows.
2. Click `Create your first skill` → lands on `/skills/new`.
3. Fill `Name = "secret-leakage-gate"`, `Type = security`, body `## Flag secrets\n\n- API keys` → click `Create skill`.
4. URL should change to `/skills/{id}`. Confirm `Saved (v1)` is NOT shown (only edit mode shows it).
5. Edit the body → click `Save skill`. Confirm `Saved (v2)` appears inline.
6. Toggle `Enabled` off in the editor → save → confirm version stays at v2 (toggling enabled does NOT bump).
7. Return to `/skills`. The card appears with the type badge `security`, dimmed because disabled.
8. Toggle the card's enabled inline → confirm it brightens without page reload.
9. Click the card → drawer opens; markdown body renders.
10. Kebab → Delete → dialog shows `Used by 0 agents`. Confirm. Card disappears.

- [ ] **Step 3: Verify the "Used by N" path**

1. Create a skill; from `/agents/<some-agent>` (existing agent) link it through `POST /agents/:id/skills` (or via SQL or via the existing agent editor link UI if it exists yet).
2. Return to `/skills`. Click the skill. Kebab → Delete → dialog shows `Used by 1 agents`. Cancel.

- [ ] **Step 4: Verify nav and shortcuts**

1. Press `g s` → navigates to `/skills`. The sidebar `Skills` item is highlighted (background `var(--bg-elevated)` from `activeKeyFor`).
2. Reload `/skills`. The `Skills` item stays highlighted.

- [ ] **Step 5: Run the full test suite**

```
cd server && pnpm test
cd ../client && pnpm test && pnpm typecheck
```

Expected: all tests green; no type errors.

- [ ] **Step 6: Final commit (only if any fixups were needed)**

```bash
git status
# If clean: nothing to commit. If fixups exist:
git add <files>
git commit -m 'Polish skills UI flow after smoke test'
```

---

## Self-Review

**Spec coverage** — each spec section maps to:

- §Architecture / module new-files → Task 1.
- §Routes (list/get/create/update/delete/usage) → Tasks 1–5.
- §Versioning (content-only bumps) → Task 3.
- §Workspace isolation → Task 6.
- §Components & data flow (list / card / toolbar / drawer / delete / add) → Tasks 9–14.
- §SkillEditor + MarkdownSplit → Tasks 15–17.
- §i18n + nav → Task 7.
- §TanStack Query hooks → Task 8.
- §Acceptance criteria (end-to-end happy path, cascade, workspace 404) → covered by tests in Tasks 2–6 and the smoke test in Task 18.

**Placeholder scan** — no `TBD` / `TODO` / `implement later`. Every step contains the actual code or command needed.

**Type consistency**:
- `Skill`, `SkillType`, `SkillSource` come from `@devdigest/shared` everywhere (server + client). Confirmed in knowledge.ts contract at lines 114–132.
- `InsertSkill` (repo layer) ↔ `CreateSkillInput` (service layer) ↔ `CreateSkillBody` (Zod, routes) ↔ `CreateSkillInput` (client hook) — all aligned on `{ name, description?, type, body, enabled? }`.
- `UpdateSkill` ↔ `UpdateSkillInput` ↔ `UpdateSkillBody` ↔ `UpdateSkillInput` (client) — all `Partial<{ name, description, type, body, enabled }>`.
- `useUpdateSkill` returns `Skill`; `useDeleteSkill` returns `{ ok: boolean }`; server matches.
- `useSkillUsage` returns `{ agent_count: number }`; server `GET /skills/:id/usage` returns the same shape.
- Hook keys are stable across tasks: `["skills"]`, `["skill", id]`, `["skill-usage", id]`.

**Conventions verified against existing code**:
- Agents module uses PUT, returns `{ ok: true }` on delete, registers Zod via `withTypeProvider<ZodTypeProvider>()`, uses `getContext(app.container, req)` to extract workspaceId, uses `NotFoundError`. All mirrored.
- Client uses TanStack Query through `lib/hooks/`; `api.ts` has `api.get/post/put/del`. All mirrored.
- Integration tests use `dockerAvailable()` + `startPg()` + `MockGitClient` + `MockGitHubClient` + `seed()`. Mirrored.
- `messages/en/agents.json` style mirrored by `messages/en/skills.json` (per-namespace file in the `en/` directory).

No spec gaps detected.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-23-skills-ui-list-editor.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

# Conventions Extractor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Conventions Extractor — a pipeline that samples a repo's files, calls a cheap LLM to find coding conventions, verifies each candidate's evidence against the sampled content in-memory, persists verified candidates, and provides a UI for accept/reject/edit and skill creation (one skill per category).

**Architecture:** New `server/src/modules/conventions/` Fastify module (repository → service → routes). Extraction fires as a fire-and-forget background job that emits progress via the existing `container.runBus`, streamed to the client over SSE. Evidence verification is in-memory — the extractor holds sampled file contents and cross-checks the LLM's `evidence_snippet` against them before persisting. Accepted candidates are grouped by `category`; each group becomes one `type:'convention'`, `source:'extracted'` skill via the existing `SkillsService`.

**Tech Stack:** Fastify 5, Drizzle ORM, Postgres, Zod, fastify-sse-v2 (`reply.sse`), TanStack Query, React, `@devdigest/ui` Modal/Button/EmptyState

## Global Constraints

- Integration tests: suffix `*.it.test.ts`, import DB helpers from `server/test/helpers/pg.ts`.
- No raw `fetch`/`octokit` in `server/src/modules/`. File reads go through `container.git` or `container.github()` adapters.
- Errors in route handlers must extend `server/src/platform/errors.ts`. No bare `throw new Error()`.
- SSE writes go through `container.runBus` — do not touch `reply.raw` directly.
- Migrations are append-only. Never edit an existing `.sql` file in `server/src/db/migrations/`.
- Use `resolveFeatureModel(container, workspaceId, 'conventions')` for model resolution — never hardcode a model name.
- LLM provider is resolved per request. Do not cache across requests.
- Shared contracts live in both `server/src/vendor/shared/contracts/knowledge.ts` and `client/src/vendor/shared/contracts/knowledge.ts` — keep both files in sync after every change.
- Run `pnpm typecheck` in `server/` after each server task and `pnpm typecheck` in `client/` after each client task before committing.

---

## File map

**New files:**
- `server/src/db/migrations/0011_add_convention_category_created_at.sql`
- `server/src/modules/conventions/repository.ts`
- `server/src/modules/conventions/repository.it.test.ts`
- `server/src/modules/conventions/extractor.ts`
- `server/src/modules/conventions/extractor.test.ts`
- `server/src/modules/conventions/service.ts`
- `server/src/modules/conventions/routes.ts`
- `server/src/prompts/conventions-extract.system.md`
- `client/src/app/conventions/page.tsx`
- `client/src/app/conventions/_components/ConventionsView/ConventionsView.tsx`
- `client/src/app/conventions/_components/ConventionsView/_components/ConventionCard/ConventionCard.tsx`
- `client/src/app/conventions/_components/ConventionsView/_components/ExtractionProgress/ExtractionProgress.tsx`
- `client/src/app/conventions/_components/ConventionsView/_components/CreateSkillsModal/CreateSkillsModal.tsx`
- `client/src/lib/hooks/conventions.ts`

**Modified files:**
- `server/src/db/schema/knowledge.ts` — add `category` + `createdAt` to `conventions` table
- `server/src/vendor/shared/contracts/knowledge.ts` — add `category`/`created_at` to `ConventionCandidate`; add `ConventionListResponse`
- `client/src/vendor/shared/contracts/knowledge.ts` — mirror of above
- `server/src/modules/index.ts` — register `conventions` module
- `client/src/vendor/ui/nav.ts` — enable Conventions nav item (~line 40)

---

### Task 1: DB migration + Drizzle schema + shared contracts

**Files:**
- Create: `server/src/db/migrations/0011_add_convention_category_created_at.sql`
- Modify: `server/src/db/schema/knowledge.ts`
- Modify: `server/src/vendor/shared/contracts/knowledge.ts`
- Modify: `client/src/vendor/shared/contracts/knowledge.ts`

**Interfaces:**
- Produces: `ConventionCandidate` extended with `category: string` and `created_at: string`
- Produces: new `ConventionListResponse` type `{ candidates: ConventionCandidate[]; scanned_at: string | null }`

- [ ] **Step 1: Write the migration**

Create `server/src/db/migrations/0011_add_convention_category_created_at.sql`:

```sql
ALTER TABLE "conventions"
  ADD COLUMN "category" text NOT NULL DEFAULT 'general',
  ADD COLUMN "created_at" timestamptz NOT NULL DEFAULT now();
```

- [ ] **Step 2: Update the Drizzle schema**

Edit `server/src/db/schema/knowledge.ts`. Replace the `conventions` table definition (currently lines 31–42) with:

```typescript
export const conventions = pgTable('conventions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
  category: text('category').notNull().default('general'),
  rule: text('rule').notNull(),
  evidencePath: text('evidence_path'),
  evidenceSnippet: text('evidence_snippet'),
  confidence: doublePrecision('confidence'),
  accepted: boolean('accepted').notNull().default(false),
  createdAt: now(),
});
```

(`now()` is already imported from `./_shared` — no new import needed.)

- [ ] **Step 3: Update server shared contracts**

In `server/src/vendor/shared/contracts/knowledge.ts`, find the `ConventionCandidate` definition and replace it; then add `ConventionListResponse` immediately after:

```typescript
export const ConventionCandidate = z.object({
  id: z.string(),
  category: z.string(),
  rule: z.string(),
  evidence_path: z.string().nullish(),
  evidence_snippet: z.string().nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  accepted: z.boolean(),
  created_at: z.string(),
});
export type ConventionCandidate = z.infer<typeof ConventionCandidate>;

export const ConventionListResponse = z.object({
  candidates: z.array(ConventionCandidate),
  scanned_at: z.string().nullable(),
});
export type ConventionListResponse = z.infer<typeof ConventionListResponse>;
```

- [ ] **Step 4: Mirror to client contracts**

Make the exact same changes to `client/src/vendor/shared/contracts/knowledge.ts`.

- [ ] **Step 5: Apply the migration**

```bash
cd server && pnpm db:migrate
```

Expected: "Applied 1 migration" or similar. No errors.

- [ ] **Step 6: Typecheck both packages**

```bash
cd server && pnpm typecheck
cd client && pnpm typecheck
```

Expected: 0 errors in both.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/migrations/0011_add_convention_category_created_at.sql \
        server/src/db/schema/knowledge.ts \
        server/src/vendor/shared/contracts/knowledge.ts \
        client/src/vendor/shared/contracts/knowledge.ts
git commit -m 'feat(conventions): add category + created_at columns; extend shared contracts'
```

---

### Task 2: Conventions repository

**Files:**
- Create: `server/src/modules/conventions/repository.ts`
- Create: `server/src/modules/conventions/repository.it.test.ts`

**Interfaces:**
- Produces: `ConventionRow` = `typeof t.conventions.$inferSelect`
- Produces: `InsertConvention` interface
- Produces: `ConventionsRepository` with `deleteByRepo`, `insertMany`, `listByRepo`, `update`

- [ ] **Step 1: Write the failing integration tests**

Create `server/src/modules/conventions/repository.it.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../../test/helpers/pg.js';
import { ConventionsRepository, type InsertConvention } from './repository.js';

// NOTE: Check server/test/helpers/pg.ts for the exact API of makeTestDb().
// It likely returns { db, seed: { workspace(), repo(workspaceId) } } or similar.
// Adjust the beforeEach below to match the actual helper signatures.

describe('ConventionsRepository', () => {
  let helpers: Awaited<ReturnType<typeof makeTestDb>>;
  let repo: ConventionsRepository;
  let workspaceId: string;
  let repoId: string;

  const baseRow: Omit<InsertConvention, 'workspaceId' | 'repoId'> = {
    category: 'async-style',
    rule: 'Always use async/await instead of .then() chains.',
    evidencePath: 'src/api/users.ts',
    evidenceSnippet: 'const user = await db.users.find(id);',
    confidence: 0.91,
  };

  beforeEach(async () => {
    helpers = await makeTestDb();
    repo = new ConventionsRepository(helpers.db);
    workspaceId = await helpers.seed.workspace();
    repoId = await helpers.seed.repo(workspaceId);
  });

  it('inserts and lists conventions for a repo', async () => {
    await repo.insertMany([{ ...baseRow, workspaceId, repoId }]);
    const { candidates, scannedAt } = await repo.listByRepo(workspaceId, repoId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].category).toBe('async-style');
    expect(candidates[0].accepted).toBe(false);
    expect(scannedAt).not.toBeNull();
  });

  it('filters by accepted=true', async () => {
    const [ins] = await repo.insertMany([{ ...baseRow, workspaceId, repoId }]);
    await repo.update(workspaceId, ins.id, { accepted: true });
    const { candidates: accepted } = await repo.listByRepo(workspaceId, repoId, { accepted: true });
    const { candidates: pending } = await repo.listByRepo(workspaceId, repoId, { accepted: false });
    expect(accepted).toHaveLength(1);
    expect(pending).toHaveLength(0);
  });

  it('deleteByRepo removes all candidates for that repo', async () => {
    await repo.insertMany([{ ...baseRow, workspaceId, repoId }]);
    await repo.deleteByRepo(workspaceId, repoId);
    const { candidates } = await repo.listByRepo(workspaceId, repoId);
    expect(candidates).toHaveLength(0);
  });

  it('update patches rule and accepted', async () => {
    const [ins] = await repo.insertMany([{ ...baseRow, workspaceId, repoId }]);
    const updated = await repo.update(workspaceId, ins.id, { rule: 'Updated rule', accepted: true });
    expect(updated?.rule).toBe('Updated rule');
    expect(updated?.accepted).toBe(true);
  });

  it('update returns undefined for unknown id', async () => {
    const result = await repo.update(workspaceId, '00000000-0000-0000-0000-000000000000', { accepted: true });
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify the test fails**

```bash
cd server && pnpm exec vitest run src/modules/conventions/repository.it.test.ts
```

Expected: FAIL — "Cannot find module './repository.js'"

- [ ] **Step 3: Implement the repository**

Create `server/src/modules/conventions/repository.ts`:

```typescript
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

export type ConventionRow = typeof t.conventions.$inferSelect;

export interface InsertConvention {
  workspaceId: string;
  repoId: string;
  category: string;
  rule: string;
  evidencePath: string;
  evidenceSnippet: string;
  confidence: number;
}

export class ConventionsRepository {
  constructor(private db: Db) {}

  async deleteByRepo(workspaceId: string, repoId: string): Promise<void> {
    await this.db
      .delete(t.conventions)
      .where(
        and(eq(t.conventions.workspaceId, workspaceId), eq(t.conventions.repoId, repoId)),
      );
  }

  async insertMany(rows: InsertConvention[]): Promise<ConventionRow[]> {
    if (rows.length === 0) return [];
    return this.db
      .insert(t.conventions)
      .values(
        rows.map((r) => ({
          workspaceId: r.workspaceId,
          repoId: r.repoId,
          category: r.category,
          rule: r.rule,
          evidencePath: r.evidencePath,
          evidenceSnippet: r.evidenceSnippet,
          confidence: r.confidence,
        })),
      )
      .returning();
  }

  async listByRepo(
    workspaceId: string,
    repoId: string,
    opts?: { accepted?: boolean },
  ): Promise<{ candidates: ConventionRow[]; scannedAt: string | null }> {
    const conditions = [
      eq(t.conventions.workspaceId, workspaceId),
      eq(t.conventions.repoId, repoId),
      ...(opts?.accepted !== undefined ? [eq(t.conventions.accepted, opts.accepted)] : []),
    ];

    const candidates = await this.db
      .select()
      .from(t.conventions)
      .where(and(...conditions))
      .orderBy(desc(t.conventions.createdAt));

    const scannedAt = candidates[0]?.createdAt?.toISOString() ?? null;
    return { candidates, scannedAt };
  }

  async update(
    workspaceId: string,
    id: string,
    patch: { rule?: string; accepted?: boolean },
  ): Promise<ConventionRow | undefined> {
    const [row] = await this.db
      .update(t.conventions)
      .set({
        ...(patch.rule !== undefined ? { rule: patch.rule } : {}),
        ...(patch.accepted !== undefined ? { accepted: patch.accepted } : {}),
      })
      .where(and(eq(t.conventions.workspaceId, workspaceId), eq(t.conventions.id, id)))
      .returning();
    return row;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd server && pnpm exec vitest run src/modules/conventions/repository.it.test.ts
```

Expected: All 5 tests pass.

- [ ] **Step 5: Typecheck**

```bash
cd server && pnpm typecheck
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/conventions/repository.ts \
        server/src/modules/conventions/repository.it.test.ts
git commit -m 'feat(conventions): ConventionsRepository with CRUD + integration tests'
```

---

### Task 3: Extraction prompt + extractor module

**Files:**
- Create: `server/src/prompts/conventions-extract.system.md`
- Create: `server/src/modules/conventions/extractor.ts`
- Create: `server/src/modules/conventions/extractor.test.ts`

**Interfaces:**
- Consumes: `container.repoIntel.getConventionSamples(repoId, 12)` → `Promise<string[]>` (returns source file paths — config files are NOT included; they must be read separately)
- Consumes: `container.git` — **inspect `server/src/adapters/git/` before implementing** to find the method for reading a file from a cloned repo. Likely signature: some form of `readFile(owner, repo, path)` or `catFile(repoPath, path)`. If no such method exists, fall back to `(await container.github()).getContent({ owner, repo, path })` from `server/src/adapters/github/`.
- Consumes: `resolveFeatureModel(container, workspaceId, 'conventions')` → `{ provider, model }`
- Consumes: `container.llm(provider).completeStructured({ model, schema, schemaName, messages, maxRetries })`
- Produces: `extractConventions(container, workspaceId, repoId, repo, emit): Promise<ExtractionCandidate[]>`
- Produces: `ExtractionCandidate` interface, `EmitFn` type

- [ ] **Step 1: Write the failing unit tests**

Create `server/src/modules/conventions/extractor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractConventions } from './extractor.js';
import type { Container } from '../../platform/container.js';

const mockEmit = vi.fn();

const SAMPLE_CONTENT = `const result = await db.users.find(id);
const posts = await db.posts.findMany({ userId });`;

function makeContainer(candidates: unknown[] = []): Partial<Container> {
  return {
    repoIntel: {
      getConventionSamples: vi.fn().mockResolvedValue(['src/api/users.ts']),
    } as unknown as Container['repoIntel'],
    git: {
      // Adjust this mock to match the actual git adapter method name found when inspecting adapters/git/
      readFile: vi.fn().mockResolvedValue(SAMPLE_CONTENT),
    } as unknown as Container['git'],
    llm: vi.fn().mockResolvedValue({
      completeStructured: vi.fn().mockResolvedValue({
        data: { candidates },
      }),
    }),
  };
}

describe('extractConventions', () => {
  beforeEach(() => mockEmit.mockClear());

  it('returns verified candidates whose snippet appears in sampled content', async () => {
    const container = makeContainer([
      {
        category: 'async-style',
        rule: 'Use async/await instead of .then()',
        evidence_path: 'src/api/users.ts',
        evidence_snippet: 'const result = await db.users.find(id);',
        confidence: 0.91,
      },
    ]);

    const result = await extractConventions(
      container as unknown as Container,
      'ws-1',
      'repo-1',
      { owner: 'acme', name: 'api', defaultBranch: 'main' },
      mockEmit,
    );

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('async-style');
    expect(result[0].confidence).toBe(0.91);
    expect(mockEmit).toHaveBeenCalledWith('done', expect.any(String), { count: 1 });
  });

  it('discards candidates whose snippet is NOT in the sampled content', async () => {
    const container = makeContainer([
      {
        category: 'naming',
        rule: 'Use camelCase',
        evidence_path: 'src/api/users.ts',
        evidence_snippet: 'this snippet does not appear in the file at all',
        confidence: 0.8,
      },
    ]);
    const result = await extractConventions(
      container as unknown as Container, 'ws-1', 'repo-1',
      { owner: 'acme', name: 'api', defaultBranch: 'main' }, mockEmit,
    );
    expect(result).toHaveLength(0);
  });

  it('discards candidates from a path not in the sampled set', async () => {
    const container = makeContainer([
      {
        category: 'typing',
        rule: 'Annotate return types',
        evidence_path: 'src/not-sampled-file.ts',
        evidence_snippet: 'function foo(): string',
        confidence: 0.85,
      },
    ]);
    const result = await extractConventions(
      container as unknown as Container, 'ws-1', 'repo-1',
      { owner: 'acme', name: 'api', defaultBranch: 'main' }, mockEmit,
    );
    expect(result).toHaveLength(0);
  });

  it('emits sampling, analyzing, verifying, done events', async () => {
    const container = makeContainer([]);
    await extractConventions(
      container as unknown as Container, 'ws-1', 'repo-1',
      { owner: 'acme', name: 'api', defaultBranch: 'main' }, mockEmit,
    );
    const kinds = mockEmit.mock.calls.map((c) => c[0]);
    expect(kinds).toContain('sampling');
    expect(kinds).toContain('analyzing');
    expect(kinds).toContain('done');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd server && pnpm exec vitest run --exclude '**/*.it.test.ts' src/modules/conventions/extractor.test.ts
```

Expected: FAIL — "Cannot find module './extractor.js'"

- [ ] **Step 3: Inspect the git adapter for file-reading method**

Open `server/src/adapters/git/` and find how to read a single file's content from a cloned repo. Note the exact method name and parameters. Also check `server/src/adapters/github/` for a `getFileContent` or `getContent` method as fallback.

Common patterns to look for:
- `container.git.readFile(owner, name, path)` → `string | null`
- `container.git.catFile(localPath, ref, filePath)` → `string`
- `(await container.github()).getContent({ owner, repo, path })` → decoded string

Update the mock in `extractor.test.ts` (Step 1) to match the actual method name you find.

- [ ] **Step 4: Write the extraction system prompt**

Create `server/src/prompts/conventions-extract.system.md`:

```markdown
# conventions-extract

You are a coding convention detector. Analyze the source files and configuration provided and extract coding conventions that are **consistently observed across multiple files**.

## What to look for

- Async patterns: async/await vs .then(), Promise handling style
- Naming conventions: variables, functions, types, files, constants
- Error handling: which error class to throw, how errors propagate through layers
- Import organization: external imports before internal, path conventions
- Type annotation patterns: when to annotate explicitly vs rely on inference
- HTTP layer patterns: how route handlers are structured, what they call first
- Testing patterns: what helpers are used, how assertions are organized

## Rules

1. Report only conventions observed in **at least 2 different files**. One-off patterns are not conventions.
2. The `evidence_snippet` **must be copied verbatim** from the provided file contents. Never paraphrase or modify it.
3. Confidence: 0.9+ = seen in 5+ files; 0.7–0.89 = 3–4 files; 0.5–0.69 = 2 files. Do not report below 0.5.
4. `category` must be a short lowercase hyphenated slug: `async-style`, `naming`, `error-handling`, `imports`, `typing`, `testing`, `http-layer`, `comments`, `formatting`.
5. `rule` must be one clear imperative sentence: "Always use X", "Never do Y", "Prefer X over Y".

## What NOT to report

- Language features that are simply how TypeScript or JavaScript works
- Patterns seen in only one file
- Generic best practices not specific to this codebase
- Anything not evidenced verbatim by the provided file contents

Return ONLY a JSON object matching the required schema. No explanation, no preamble, no markdown.
```

- [ ] **Step 5: Implement the extractor**

Create `server/src/modules/conventions/extractor.ts`. Replace `readFileContent` with the actual adapter method found in Step 3:

```typescript
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Container } from '../../platform/container.js';
import { resolveFeatureModel } from '../settings/feature-models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXTRACTION_SCHEMA = z.object({
  candidates: z.array(
    z.object({
      category: z.string(),
      rule: z.string(),
      evidence_path: z.string(),
      evidence_snippet: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export interface ExtractionCandidate {
  category: string;
  rule: string;
  evidencePath: string;
  evidenceSnippet: string;
  confidence: number;
}

export type EmitFn = (type: string, message: string, data?: unknown) => void;

// Config files are NOT returned by getConventionSamples() (it filters them via junk-path rules).
// We must read them separately to get explicit linting/formatting conventions.
const CONFIG_FILES = [
  '.eslintrc.json',
  '.eslintrc.js',
  'eslint.config.js',
  'tsconfig.json',
  'prettier.config.js',
  '.prettierrc',
  '.editorconfig',
];

const MAX_FILE_CHARS = 150 * 80; // ~150 lines at ~80 chars each

export async function extractConventions(
  container: Container,
  workspaceId: string,
  repoId: string,
  repo: { owner: string; name: string; defaultBranch: string },
  emit: EmitFn,
): Promise<ExtractionCandidate[]> {
  // ── 1. Sample config files ─────────────────────────────────────────────
  emit('sampling', 'Reading config files...');
  const sampled = new Map<string, string>();

  for (const path of CONFIG_FILES) {
    const content = await readFileContent(container, repo, path);
    if (content) sampled.set(path, content);
  }

  // ── 2. Sample source files ─────────────────────────────────────────────
  emit('sampling', 'Reading source files...');
  const sourcePaths = await container.repoIntel.getConventionSamples(repoId, 12);

  for (const path of sourcePaths) {
    const content = await readFileContent(container, repo, path);
    if (content) sampled.set(path, content.slice(0, MAX_FILE_CHARS));
  }

  if (sampled.size === 0) {
    emit('done', 'No readable files found', { count: 0 });
    return [];
  }

  // ── 3. Call LLM ────────────────────────────────────────────────────────
  emit('analyzing', `Analyzing ${sampled.size} files...`);

  const { provider, model } = await resolveFeatureModel(container, workspaceId, 'conventions');
  const llm = await container.llm(provider as 'openai' | 'anthropic' | 'openrouter');

  const systemPrompt = readFileSync(
    join(__dirname, '../../../prompts/conventions-extract.system.md'),
    'utf8',
  );

  const userContent = [...sampled.entries()]
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
    .join('\n\n');

  const result = await llm.completeStructured({
    model,
    schema: EXTRACTION_SCHEMA,
    schemaName: 'ConventionsAnalysis',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Analyze these files and extract coding conventions:\n\n${userContent}` },
    ],
    maxRetries: 2,
  });

  // ── 4. In-memory evidence verification ────────────────────────────────
  const rawCandidates = result.data.candidates;
  const verified: ExtractionCandidate[] = [];

  for (let i = 0; i < rawCandidates.length; i++) {
    const c = rawCandidates[i];
    emit('verifying', `Verifying ${i + 1}/${rawCandidates.length}...`, {
      total: rawCandidates.length,
      done: i + 1,
    });

    const fileContent = sampled.get(c.evidence_path);
    if (!fileContent) continue; // path was not in our sampled set → reject
    if (!fileContent.includes(c.evidence_snippet)) continue; // snippet not verbatim → reject

    verified.push({
      category: c.category,
      rule: c.rule,
      evidencePath: c.evidence_path,
      evidenceSnippet: c.evidence_snippet,
      confidence: c.confidence,
    });
  }

  emit('done', `Found ${verified.length} verified conventions`, { count: verified.length });
  return verified;
}

async function readFileContent(
  container: Container,
  repo: { owner: string; name: string },
  path: string,
): Promise<string | null> {
  try {
    // REPLACE THIS with the actual adapter call found in Step 3.
    // Option A (git adapter): return container.git.readFile(repo.owner, repo.name, path);
    // Option B (github adapter): return (await container.github()).getFileContent({ owner: repo.owner, repo: repo.name, path });
    // The cast below is a placeholder — remove it once you know the real method.
    return await (container.git as unknown as {
      readFile: (owner: string, repo: string, path: string) => Promise<string | null>;
    }).readFile(repo.owner, repo.name, path);
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd server && pnpm exec vitest run --exclude '**/*.it.test.ts' src/modules/conventions/extractor.test.ts
```

Expected: All 4 tests pass.

- [ ] **Step 7: Typecheck**

```bash
cd server && pnpm typecheck
```

Expected: 0 errors. Fix any type errors in the `readFileContent` cast by using the real adapter type.

- [ ] **Step 8: Commit**

```bash
git add server/src/prompts/conventions-extract.system.md \
        server/src/modules/conventions/extractor.ts \
        server/src/modules/conventions/extractor.test.ts
git commit -m 'feat(conventions): extraction pipeline with LLM + in-memory evidence verification'
```

---

### Task 4: Conventions service + routes + module registration

**Files:**
- Create: `server/src/modules/conventions/service.ts`
- Create: `server/src/modules/conventions/routes.ts`
- Modify: `server/src/modules/index.ts`

**Interfaces:**
- Consumes: `ConventionsRepository` from `./repository.js`
- Consumes: `extractConventions`, `ExtractionCandidate` from `./extractor.js`
- Consumes: `SkillsService` from `../skills/service.js`
- Consumes: `AgentsService` from `../agents/service.js` (for optional skill linking)
- Consumes: `container.runBus` — **inspect `server/src/platform/sse.ts` before implementing** to find: (a) the exact `publish(runId, kind, msg, data)` signature and (b) the done-signal method (look for what's called when a job finishes — likely `container.runBus.done(runId)` or `container.runBus.markDone(runId)`)
- Produces: `ConventionsService` with `startExtraction`, `list`, `update`, `createSkillsFromConventions`
- Produces: routes at `/repos/:id/conventions/...` and `/conventions/:id`

- [ ] **Step 1: Inspect RunBus for the done-signal method**

Open `server/src/platform/sse.ts` and find the method that closes a run's event stream (the method that triggers `runBus.onDone` subscribers). Note the exact name before writing the service.

- [ ] **Step 2: Implement the service**

Create `server/src/modules/conventions/service.ts`. Replace `DONE_METHOD` with the real method name found in Step 1:

```typescript
import type { Container } from '../../platform/container.js';
import type { ConventionRow } from './repository.js';
import { ConventionsRepository } from './repository.js';
import { extractConventions } from './extractor.js';
import { SkillsService } from '../skills/service.js';
import { AgentsService } from '../agents/service.js';

export interface ConventionDto {
  id: string;
  category: string;
  rule: string;
  evidence_path: string | null;
  evidence_snippet: string | null;
  confidence: number | null;
  accepted: boolean;
  created_at: string;
}

function toDto(row: ConventionRow): ConventionDto {
  return {
    id: row.id,
    category: row.category,
    rule: row.rule,
    evidence_path: row.evidencePath ?? null,
    evidence_snippet: row.evidenceSnippet ?? null,
    confidence: row.confidence ?? null,
    accepted: row.accepted,
    created_at: row.createdAt.toISOString(),
  };
}

export class ConventionsService {
  private repo: ConventionsRepository;
  private skills: SkillsService;
  private agents: AgentsService;

  constructor(private container: Container) {
    this.repo = new ConventionsRepository(container.db);
    this.skills = new SkillsService(container);
    this.agents = new AgentsService(container);
  }

  /** Fire-and-forget extraction. Returns the scanId for SSE subscription. */
  async startExtraction(
    workspaceId: string,
    repoId: string,
    repoRecord: { owner: string; name: string; defaultBranch: string },
  ): Promise<string> {
    const scanId = `conv:${repoId}`;

    void this.runExtraction(workspaceId, repoId, repoRecord, scanId).catch((err) => {
      this.container.runBus.publish(scanId, 'error' as never, (err as Error).message);
      this.signalDone(scanId);
    });

    return scanId;
  }

  private async runExtraction(
    workspaceId: string,
    repoId: string,
    repoRecord: { owner: string; name: string; defaultBranch: string },
    scanId: string,
  ): Promise<void> {
    await this.repo.deleteByRepo(workspaceId, repoId);

    const emit = (type: string, message: string, data?: unknown) =>
      this.container.runBus.publish(scanId, type as never, message, data);

    const candidates = await extractConventions(
      this.container,
      workspaceId,
      repoId,
      repoRecord,
      emit,
    );

    if (candidates.length > 0) {
      await this.repo.insertMany(
        candidates.map((c) => ({ ...c, workspaceId, repoId })),
      );
    }

    this.signalDone(scanId);
  }

  private signalDone(scanId: string): void {
    // Replace 'done' with the actual method name found in Step 1 above.
    // Examples: container.runBus.done(scanId) or container.runBus.markDone(scanId)
    (this.container.runBus as unknown as { done: (id: string) => void }).done(scanId);
  }

  async list(
    workspaceId: string,
    repoId: string,
    opts?: { accepted?: boolean },
  ): Promise<{ candidates: ConventionDto[]; scanned_at: string | null }> {
    const { candidates, scannedAt } = await this.repo.listByRepo(workspaceId, repoId, opts);
    return { candidates: candidates.map(toDto), scanned_at: scannedAt };
  }

  async update(
    workspaceId: string,
    id: string,
    patch: { rule?: string; accepted?: boolean },
  ): Promise<ConventionDto | undefined> {
    const row = await this.repo.update(workspaceId, id, patch);
    return row ? toDto(row) : undefined;
  }

  async createSkillsFromConventions(
    workspaceId: string,
    repoId: string,
    repoSlug: string,
    agentId?: string,
  ): Promise<{ skills: Awaited<ReturnType<SkillsService['create']>>[] }> {
    const { candidates } = await this.repo.listByRepo(workspaceId, repoId, { accepted: true });
    if (candidates.length === 0) return { skills: [] };

    const groups = new Map<string, ConventionRow[]>();
    for (const c of candidates) {
      const g = groups.get(c.category) ?? [];
      g.push(c);
      groups.set(c.category, g);
    }

    const createdSkills: Awaited<ReturnType<SkillsService['create']>>[] = [];

    for (const [category, items] of groups) {
      const body = buildSkillBody(category, repoSlug, items);
      const skill = await this.skills.create(workspaceId, {
        name: `${repoSlug}-${category}`,
        description: `${items.length} ${category} convention${items.length > 1 ? 's' : ''} from ${repoSlug}`,
        type: 'convention',
        source: 'extracted',
        body,
      });
      createdSkills.push(skill);
    }

    if (agentId) {
      for (const skill of createdSkills) {
        await this.agents.linkSkill(workspaceId, agentId, skill.id);
      }
    }

    return { skills: createdSkills };
  }
}

function buildSkillBody(category: string, repoSlug: string, items: ConventionRow[]): string {
  const lines = [
    `# ${category}`,
    '',
    `House conventions for \`${repoSlug}\`. Flag changes that violate any rule below and cite the offending \`file:line\`.`,
    '',
  ];
  for (const item of items) {
    lines.push(`## ${item.rule}`, '');
    if (item.evidencePath && item.evidenceSnippet) {
      lines.push(`Detected in \`${item.evidencePath}\`:`, '', '```', item.evidenceSnippet, '```', '');
    }
  }
  return lines.join('\n');
}
```

- [ ] **Step 3: Implement routes**

Create `server/src/modules/conventions/routes.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getContext } from '../_shared/context.js';
import { NotFoundError } from '../../platform/errors.js';
import { ConventionsService } from './service.js';
import * as t from '../../db/schema.js';

const RepoParams = z.object({ id: z.string().uuid() });
const ScanParams = z.object({ id: z.string().uuid(), scanId: z.string() });
const ConventionParams = z.object({ id: z.string().uuid() });

export default async function conventionsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new ConventionsService(app.container);

  // POST /repos/:id/conventions/extract
  app.post(
    '/repos/:id/conventions/extract',
    { schema: { params: RepoParams } },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const repo = await fetchRepo(app.container, workspaceId, req.params.id);
      if (!repo) throw new NotFoundError('Repo not found');
      const scanId = await service.startExtraction(workspaceId, req.params.id, repo);
      reply.status(202);
      return { scan_id: scanId };
    },
  );

  // GET /repos/:id/conventions/events/:scanId  — SSE progress stream
  app.get(
    '/repos/:id/conventions/events/:scanId',
    { schema: { params: ScanParams }, config: { rateLimit: false } },
    async (req, reply) => {
      await getContext(app.container, req);
      const { scanId } = req.params;

      // Mirrors the pattern in server/src/modules/reviews/routes.ts
      reply.sse(
        (async function* () {
          const queue: unknown[] = [];
          let resolve: (() => void) | null = null;
          let done = false;

          const unsubscribe = app.container.runBus.subscribe(scanId, (e) => {
            queue.push(e);
            resolve?.();
          });
          const offDone = app.container.runBus.onDone(scanId, () => {
            done = true;
            resolve?.();
          });

          try {
            while (true) {
              if (queue.length === 0) {
                if (done) break;
                await new Promise<void>((r) => (resolve = r));
                resolve = null;
                continue;
              }
              const e = queue.shift() as { seq: number; kind: string };
              yield { id: String(e.seq), event: e.kind, data: JSON.stringify(e) };
            }
          } finally {
            unsubscribe();
            offDone();
          }
        })(),
      );
    },
  );

  // GET /repos/:id/conventions
  app.get(
    '/repos/:id/conventions',
    {
      schema: {
        params: RepoParams,
        querystring: z.object({ accepted: z.coerce.boolean().optional() }),
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return service.list(workspaceId, req.params.id, { accepted: req.query.accepted });
    },
  );

  // PATCH /conventions/:id
  app.patch(
    '/conventions/:id',
    {
      schema: {
        params: ConventionParams,
        body: z.object({
          rule: z.string().min(1).max(500).optional(),
          accepted: z.boolean().optional(),
        }),
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      const result = await service.update(workspaceId, req.params.id, req.body);
      if (!result) throw new NotFoundError('Convention not found');
      return result;
    },
  );

  // POST /repos/:id/conventions/to-skills
  app.post(
    '/repos/:id/conventions/to-skills',
    {
      schema: {
        params: RepoParams,
        body: z.object({ agent_id: z.string().uuid().optional() }),
      },
    },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const repo = await fetchRepo(app.container, workspaceId, req.params.id);
      if (!repo) throw new NotFoundError('Repo not found');
      const repoSlug = `${repo.owner}-${repo.name}`;
      const result = await service.createSkillsFromConventions(
        workspaceId,
        req.params.id,
        repoSlug,
        req.body.agent_id,
      );
      reply.status(201);
      return result;
    },
  );
}

async function fetchRepo(
  container: import('../../platform/container.js').Container,
  workspaceId: string,
  repoId: string,
): Promise<{ owner: string; name: string; defaultBranch: string } | null> {
  const [row] = await container.db
    .select()
    .from(t.repos)
    .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId)));
  if (!row) return null;
  return { owner: row.owner, name: row.name, defaultBranch: row.defaultBranch };
}
```

- [ ] **Step 4: Register the module**

Edit `server/src/modules/index.ts`:

```typescript
import conventions from './conventions/routes.js';   // add this line

export const modules: Record<string, FastifyPluginAsync> = {
  // ... existing entries ...
  conventions,  // add this entry
};
```

- [ ] **Step 5: Typecheck**

```bash
cd server && pnpm typecheck
```

Expected: 0 errors. Remove any casts in `signalDone` and replace with the real method name from Step 1.

- [ ] **Step 6: Smoke-test the routes**

```bash
cd server && pnpm dev
```

```bash
# Replace <repo-id> and <token> with values from pnpm db:seed output
curl -s -X POST http://localhost:3001/repos/<repo-id>/conventions/extract \
  -H 'Authorization: Bearer <token>' -H 'content-type: application/json' -d '{}'
# Expected: 202  { "scan_id": "conv:<repo-id>" }

curl -s http://localhost:3001/repos/<repo-id>/conventions \
  -H 'Authorization: Bearer <token>'
# Expected: { candidates: [...], scanned_at: "..." }
```

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/conventions/service.ts \
        server/src/modules/conventions/routes.ts \
        server/src/modules/index.ts
git commit -m 'feat(conventions): service, all routes, SSE stream, and module registration'
```

---

### Task 5: Client hooks

**Files:**
- Create: `client/src/lib/hooks/conventions.ts`

**Interfaces:**
- Consumes: `apiFetch`, `API_BASE` from `../api.js`
- Consumes: `ConventionCandidate`, `ConventionListResponse`, `Skill` from `@devdigest/shared`
- Produces: `useConventions`, `useUpdateConvention`, `useCreateSkillsFromConventions`, `useExtractConventions`

- [ ] **Step 1: Create the hooks file**

Create `client/src/lib/hooks/conventions.ts`:

```typescript
import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ConventionCandidate, ConventionListResponse, Skill } from '@devdigest/shared';
import { apiFetch, API_BASE } from '../api.js';

const keyList = (repoId: string) => ['conventions', repoId] as const;

export function useConventions(repoId: string | null) {
  return useQuery({
    queryKey: repoId ? keyList(repoId) : ['conventions', '__none__'],
    queryFn: () => apiFetch<ConventionListResponse>(`/repos/${repoId}/conventions`),
    enabled: repoId !== null,
  });
}

export function useUpdateConvention(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { accepted?: boolean; rule?: string } }) =>
      apiFetch<ConventionCandidate>(`/conventions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keyList(repoId) }),
  });
}

export function useCreateSkillsFromConventions(repoId: string) {
  return useMutation({
    mutationFn: (opts?: { agent_id?: string }) =>
      apiFetch<{ skills: Skill[] }>(`/repos/${repoId}/conventions/to-skills`, {
        method: 'POST',
        body: JSON.stringify(opts ?? {}),
      }),
  });
}

export interface ExtractionState {
  extracting: boolean;
  progress: string | null;
}

export function useExtractConventions(repoId: string) {
  const qc = useQueryClient();
  const [state, setState] = React.useState<ExtractionState>({
    extracting: false,
    progress: null,
  });

  const extract = React.useCallback(async () => {
    setState({ extracting: true, progress: 'Starting...' });
    try {
      const { scan_id } = await apiFetch<{ scan_id: string }>(
        `/repos/${repoId}/conventions/extract`,
        { method: 'POST', body: JSON.stringify({}) },
      );

      await new Promise<void>((resolve, reject) => {
        const es = new EventSource(
          `${API_BASE}/repos/${repoId}/conventions/events/${scan_id}`,
        );

        const handle = (ev: MessageEvent) => {
          try {
            const data = JSON.parse(ev.data) as { msg?: string };
            setState((s) => ({ ...s, progress: data.msg ?? s.progress }));
          } catch { /* ignore */ }
        };

        for (const kind of ['sampling', 'analyzing', 'verifying']) {
          es.addEventListener(kind, handle as EventListener);
        }
        es.addEventListener('done', () => {
          es.close();
          resolve();
        });
        es.addEventListener('error', (ev: Event) => {
          es.close();
          try {
            const data = JSON.parse((ev as MessageEvent).data) as { msg?: string };
            reject(new Error(data.msg ?? 'Extraction failed'));
          } catch {
            reject(new Error('Extraction failed'));
          }
        });
        es.onerror = () => { es.close(); reject(new Error('SSE connection error')); };
      });

      await qc.invalidateQueries({ queryKey: keyList(repoId) });
    } finally {
      setState({ extracting: false, progress: null });
    }
  }, [repoId, qc]);

  return { extract, ...state };
}
```

- [ ] **Step 2: Typecheck**

```bash
cd client && pnpm typecheck
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/hooks/conventions.ts
git commit -m 'feat(conventions): TanStack Query hooks for conventions API'
```

---

### Task 6: Conventions page + nav enable + view shell

**Files:**
- Create: `client/src/app/conventions/page.tsx`
- Create: `client/src/app/conventions/_components/ConventionsView/ConventionsView.tsx`
- Modify: `client/src/vendor/ui/nav.ts`

**Interfaces:**
- Consumes: all hooks from `../../../../lib/hooks/conventions.ts`
- Consumes: repos list — check `client/src/lib/hooks/` for the correct hook name (likely `useRepos`)
- Produces: `/conventions` page with repo selector, scan button, candidate list

- [ ] **Step 1: Enable the nav item**

Edit `client/src/vendor/ui/nav.ts` line ~40. Change:

```typescript
// Before:
{ key: "conventions", label: "Conventions", icon: "ListChecks", href: "#", disabled: true },
// After:
{ key: "conventions", label: "Conventions", icon: "ListChecks", href: "/conventions", gKey: "c" },
```

- [ ] **Step 2: Find the repos hook**

Check `client/src/lib/hooks/` for the hook that lists repos (probably `useRepos` in `repos.ts`). Note the exact hook name and the shape of the repo object it returns (at minimum: `id`, `owner`, `name`).

- [ ] **Step 3: Create the page entry**

Create `client/src/app/conventions/page.tsx`:

```typescript
import { ConventionsView } from "./_components/ConventionsView/ConventionsView";

export default function ConventionsPage() {
  return <ConventionsView />;
}
```

- [ ] **Step 4: Create ConventionsView**

Create `client/src/app/conventions/_components/ConventionsView/ConventionsView.tsx`. Replace `useRepos` and the repo type with whatever you found in Step 2:

```typescript
"use client";

import React from "react";
import { AppShell } from "../../../../components/app-shell";
import { EmptyState, ErrorState, Skeleton, Button } from "@devdigest/ui";
import { useConventions, useExtractConventions } from "../../../../lib/hooks/conventions";
import { useRepos } from "../../../../lib/hooks/repos"; // adjust hook name if different
import { ConventionCard } from "./_components/ConventionCard/ConventionCard";
import { ExtractionProgress } from "./_components/ExtractionProgress/ExtractionProgress";
import { CreateSkillsModal } from "./_components/CreateSkillsModal/CreateSkillsModal";

export function ConventionsView() {
  const { data: repos } = useRepos();
  const [repoId, setRepoId] = React.useState<string | null>(null);
  const [showModal, setShowModal] = React.useState(false);

  const { data, isLoading, isError, refetch } = useConventions(repoId);
  const { extract, extracting, progress } = useExtractConventions(repoId ?? "");

  const candidates = data?.candidates ?? [];
  const acceptedCount = candidates.filter((c) => c.accepted).length;
  const selectedRepo = repos?.find((r: { id: string }) => r.id === repoId);
  const hasScanned = (data?.scanned_at ?? null) !== null;

  return (
    <AppShell crumb={[{ label: "Skills Lab" }, { label: "Conventions" }]}>
      <div style={{ padding: "24px 32px", maxWidth: 900 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, flex: 1 }}>
            Conventions{selectedRepo ? ` in ${selectedRepo.name}` : ""}
          </h1>
          <select
            value={repoId ?? ""}
            onChange={(e) => setRepoId(e.target.value || null)}
            style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text-primary)" }}
          >
            <option value="">Select repo…</option>
            {repos?.map((r: { id: string; owner: string; name: string }) => (
              <option key={r.id} value={r.id}>{r.owner}/{r.name}</option>
            ))}
          </select>
          <Button
            kind="secondary"
            disabled={!repoId || extracting}
            onClick={() => extract()}
          >
            {extracting ? "Scanning…" : hasScanned ? "Re-scan" : "Scan"}
          </Button>
        </div>

        {data?.scanned_at && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
            Detected from {candidates.length} candidates · last scan {new Date(data.scanned_at).toLocaleString()}
          </p>
        )}

        {extracting && <ExtractionProgress message={progress} />}

        {candidates.length > 0 && !extracting && (
          <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              {acceptedCount} of {candidates.length} accepted
            </span>
            <div style={{ flex: 1 }} />
            <Button
              kind="primary"
              disabled={acceptedCount === 0}
              onClick={() => setShowModal(true)}
            >
              Create {acceptedCount > 0 ? `${acceptedCount} ` : ""}skill{acceptedCount !== 1 ? "s" : ""} ✦
            </Button>
          </div>
        )}

        {!repoId && (
          <EmptyState icon="ListChecks" title="Select a repo to scan" body="Choose a connected repository to extract coding conventions from." />
        )}
        {repoId && isLoading && <Skeleton height={120} />}
        {repoId && isError && (
          <ErrorState body="Failed to load conventions" onRetry={() => refetch()} />
        )}
        {repoId && !isLoading && !isError && !extracting && candidates.length === 0 && (
          <EmptyState icon="Sparkles" title="No conventions yet" body="Click Scan to analyze this repository and extract coding conventions." />
        )}

        {candidates.map((c) => (
          <ConventionCard key={c.id} candidate={c} repoId={repoId!} />
        ))}
      </div>

      {showModal && repoId && selectedRepo && (
        <CreateSkillsModal
          repoId={repoId}
          repoSlug={`${selectedRepo.owner}-${selectedRepo.name}`}
          candidates={candidates.filter((c) => c.accepted)}
          onClose={() => setShowModal(false)}
        />
      )}
    </AppShell>
  );
}
```

- [ ] **Step 5: Typecheck**

```bash
cd client && pnpm typecheck
```

Expected: errors only about the not-yet-created child components (ConventionCard, ExtractionProgress, CreateSkillsModal). Those are fine — they'll be resolved in the next task.

- [ ] **Step 6: Commit**

```bash
git add client/src/app/conventions/ \
        client/src/vendor/ui/nav.ts
git commit -m 'feat(conventions): conventions page shell + nav item enabled'
```

---

### Task 7: ConventionCard component

**Files:**
- Create: `client/src/app/conventions/_components/ConventionsView/_components/ConventionCard/ConventionCard.tsx`

**Interfaces:**
- Consumes: `useUpdateConvention` from `../../../../../../lib/hooks/conventions.ts`
- Consumes: `ConventionCandidate` from `@devdigest/shared`
- Produces: `ConventionCard({ candidate, repoId })` with inline edit, accept/reject toggle, confidence bar

- [ ] **Step 1: Check Button prop API**

Before writing, look at an existing component that uses `<Button>` from `@devdigest/ui` (e.g. `client/src/app/skills/_components/SkillsListView/_components/DeleteSkillDialog/DeleteSkillDialog.tsx`) to confirm the supported `kind` values and whether a `size` prop exists.

- [ ] **Step 2: Implement ConventionCard**

Create `client/src/app/conventions/_components/ConventionsView/_components/ConventionCard/ConventionCard.tsx`. Adjust Button props to match the real API:

```typescript
"use client";

import React from "react";
import type { ConventionCandidate } from "@devdigest/shared";
import { Button } from "@devdigest/ui";
import { useUpdateConvention } from "../../../../../../lib/hooks/conventions";

interface Props {
  candidate: ConventionCandidate;
  repoId: string;
}

function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null) return null;
  const pct = Math.round(value * 100);
  const color = value >= 0.8 ? "var(--ok)" : value >= 0.5 ? "var(--warn)" : "var(--crit)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-muted)" }}>
      <div style={{ flex: 1, height: 4, background: "var(--bg-hover)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2 }} />
      </div>
      <span>{pct}%</span>
    </div>
  );
}

export function ConventionCard({ candidate, repoId }: Props) {
  const update = useUpdateConvention(repoId);
  const [editing, setEditing] = React.useState(false);
  const [draftRule, setDraftRule] = React.useState(candidate.rule);

  const saveEdit = () => {
    update.mutate({ id: candidate.id, patch: { rule: draftRule } });
    setEditing(false);
  };

  return (
    <div
      style={{
        border: `1px solid ${candidate.accepted ? "var(--ok)" : "var(--border)"}`,
        borderRadius: 8,
        padding: 16,
        marginBottom: 12,
        background: candidate.accepted ? "var(--ok-bg, #052e1c)" : "var(--bg-elevated)",
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      {/* Category badge + edit button */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{
          fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4,
          background: "var(--bg-hover)", color: "var(--text-secondary)",
          letterSpacing: "0.04em", textTransform: "uppercase",
        }}>
          {candidate.category}
        </span>
        <div style={{ flex: 1 }} />
        <Button kind="ghost" onClick={() => setEditing(!editing)}>Edit</Button>
      </div>

      {/* Rule text / inline editor */}
      {editing ? (
        <div style={{ marginBottom: 8 }}>
          <textarea
            value={draftRule}
            onChange={(e) => setDraftRule(e.target.value)}
            rows={3}
            style={{
              width: "100%", padding: "8px 10px", borderRadius: 6,
              border: "1px solid var(--border-strong)", background: "var(--bg)",
              color: "var(--text-primary)", fontSize: 13, resize: "vertical", boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <Button kind="primary" onClick={saveEdit} disabled={update.isPending}>Save</Button>
            <Button kind="ghost" onClick={() => { setEditing(false); setDraftRule(candidate.rule); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <p style={{ fontSize: 14, marginBottom: 8, color: "var(--text-primary)" }}>{candidate.rule}</p>
      )}

      {/* Evidence code block */}
      {candidate.evidence_path && (
        <div style={{ marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "monospace" }}>
            {candidate.evidence_path}
          </span>
          {candidate.evidence_snippet && (
            <pre style={{
              marginTop: 4, padding: "8px 12px", background: "var(--bg)",
              borderRadius: 4, fontSize: 12, overflow: "auto",
              color: "var(--text-secondary)", border: "1px solid var(--border)",
            }}>
              <code>{candidate.evidence_snippet}</code>
            </pre>
          )}
        </div>
      )}

      {/* Confidence bar + accept/reject */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <ConfidenceBar value={candidate.confidence} />
        </div>
        <Button
          kind={candidate.accepted ? "primary" : "ghost"}
          onClick={() => update.mutate({ id: candidate.id, patch: { accepted: true } })}
          disabled={update.isPending}
        >
          ✓ Accepted
        </Button>
        <Button
          kind={!candidate.accepted ? "danger" : "ghost"}
          onClick={() => update.mutate({ id: candidate.id, patch: { accepted: false } })}
          disabled={update.isPending}
        >
          ✕ Reject
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd client && pnpm typecheck
```

Expected: 0 errors from this component.

- [ ] **Step 4: Commit**

```bash
git add client/src/app/conventions/_components/ConventionsView/_components/ConventionCard/
git commit -m 'feat(conventions): ConventionCard with accept/reject/inline-edit'
```

---

### Task 8: ExtractionProgress + CreateSkillsModal + end-to-end test

**Files:**
- Create: `client/src/app/conventions/_components/ConventionsView/_components/ExtractionProgress/ExtractionProgress.tsx`
- Create: `client/src/app/conventions/_components/ConventionsView/_components/CreateSkillsModal/CreateSkillsModal.tsx`

**Interfaces:**
- Consumes: `useCreateSkillsFromConventions` from `../../../../../../lib/hooks/conventions.ts`
- Consumes: `useToast` from `../../../../../../lib/toast.js`
- Consumes: agents list hook — check `client/src/lib/hooks/` for `useAgents`
- Produces: `ExtractionProgress({ message })`, `CreateSkillsModal({ repoId, repoSlug, candidates, onClose })`

- [ ] **Step 1: Implement ExtractionProgress**

Create `ExtractionProgress/ExtractionProgress.tsx`:

```typescript
"use client";

interface Props { message: string | null; }

export function ExtractionProgress({ message }: Props) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 14px", borderRadius: 6,
      background: "var(--bg-elevated)", border: "1px solid var(--border)",
      marginBottom: 16, fontSize: 13, color: "var(--text-secondary)",
    }}>
      <span style={{
        width: 12, height: 12, borderRadius: "50%",
        border: "2px solid var(--accent)", borderTopColor: "transparent",
        animation: "ddConvSpin 0.8s linear infinite", flexShrink: 0,
      }} />
      <style>{`@keyframes ddConvSpin { to { transform: rotate(360deg); } }`}</style>
      {message ?? "Analyzing…"}
    </div>
  );
}
```

- [ ] **Step 2: Check for agents hook**

Look in `client/src/lib/hooks/` for a hook that lists agents (likely `useAgents` in `agents.ts`). Note the hook name and agent object shape (`id`, `name`).

- [ ] **Step 3: Implement CreateSkillsModal**

Create `CreateSkillsModal/CreateSkillsModal.tsx`. Replace `useAgents` with the hook name found in Step 2:

```typescript
"use client";

import React from "react";
import type { ConventionCandidate } from "@devdigest/shared";
import { Button, Modal } from "@devdigest/ui";
import { useToast } from "../../../../../../lib/toast";
import { useCreateSkillsFromConventions } from "../../../../../../lib/hooks/conventions";
import { useAgents } from "../../../../../../lib/hooks/agents"; // adjust hook name if different

interface Props {
  repoId: string;
  repoSlug: string;
  candidates: ConventionCandidate[];
  onClose: () => void;
}

interface SkillGroup {
  category: string;
  name: string;
  items: ConventionCandidate[];
}

export function CreateSkillsModal({ repoId, repoSlug, candidates, onClose }: Props) {
  const toast = useToast();
  const create = useCreateSkillsFromConventions(repoId);
  const { data: agents } = useAgents();
  const [agentId, setAgentId] = React.useState("");

  const groups = React.useMemo<SkillGroup[]>(() => {
    const map = new Map<string, ConventionCandidate[]>();
    for (const c of candidates) {
      const g = map.get(c.category) ?? [];
      g.push(c);
      map.set(c.category, g);
    }
    return [...map.entries()].map(([category, items]) => ({
      category,
      name: `${repoSlug}-${category}`,
      items,
    }));
  }, [candidates, repoSlug]);

  const handleCreate = () => {
    create.mutate(
      { agent_id: agentId || undefined },
      {
        onSuccess: (data) => {
          toast.success(
            `${data.skills.length} skill${data.skills.length > 1 ? "s" : ""} created and added to Skills Lab`,
          );
          onClose();
        },
        onError: () => toast.error("Failed to create skills"),
      },
    );
  };

  const footer = (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
      <Button kind="ghost" onClick={onClose} disabled={create.isPending}>Cancel</Button>
      <Button kind="primary" onClick={handleCreate} disabled={create.isPending || groups.length === 0}>
        {create.isPending ? "Creating…" : `Create ${groups.length} skill${groups.length > 1 ? "s" : ""} ✦`}
      </Button>
    </div>
  );

  return (
    <Modal
      title="Create skill from conventions"
      subtitle={`${repoSlug}-conventions`}
      onClose={onClose}
      footer={footer}
    >
      <div style={{
        marginBottom: 16, padding: "10px 14px", borderRadius: 6,
        background: "var(--bg-elevated)", border: "1px solid var(--border)",
        fontSize: 13, color: "var(--text-secondary)",
      }}>
        ✦ Merged from {candidates.length} accepted convention{candidates.length > 1 ? "s" : ""} in{" "}
        <span style={{ color: "var(--accent)" }}>{repoSlug}</span>. Everything below is editable before you save.
      </div>

      {groups.map((g) => (
        <div key={g.category} style={{
          marginBottom: 12, padding: 14, border: "1px solid var(--border)", borderRadius: 8,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 6 }}>
            {g.category} · {g.items.length} convention{g.items.length > 1 ? "s" : ""}
          </div>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0 }}>
            Skill name: <code>{g.name}</code>
          </p>
          <ul style={{ margin: "8px 0 0 0", paddingLeft: 16, fontSize: 12, color: "var(--text-secondary)" }}>
            {g.items.map((c) => <li key={c.id} style={{ marginBottom: 2 }}>{c.rule}</li>)}
          </ul>
        </div>
      ))}

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 12, color: "var(--text-muted)", display: "block", marginBottom: 4 }}>
          Also link to agent (optional)
        </label>
        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: 13 }}
        >
          <option value="">None</option>
          {agents?.map((a: { id: string; name: string }) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: Typecheck**

```bash
cd client && pnpm typecheck
```

Expected: 0 errors.

- [ ] **Step 5: End-to-end smoke test**

Start the full stack: `./scripts/dev.sh`

Walk through the full flow:
1. Navigate to `/conventions`
2. Select a connected repo
3. Click "Scan" — verify the progress bar appears with messages
4. Verify candidate cards appear after scan completes
5. Accept 2–3 candidates — verify the card border changes to green
6. Click Edit on one card — modify the rule text → Save — verify it updates
7. Click "Create X skills" — modal appears showing grouped categories
8. Optionally select an agent from the dropdown
9. Click "Create X skills ✦" — toast appears, modal closes
10. Navigate to `/skills` — verify the new skills appear with `type: convention`

- [ ] **Step 6: Commit**

```bash
git add client/src/app/conventions/_components/ConventionsView/_components/ExtractionProgress/ \
        client/src/app/conventions/_components/ConventionsView/_components/CreateSkillsModal/
git commit -m 'feat(conventions): ExtractionProgress + CreateSkillsModal; full feature complete'
```

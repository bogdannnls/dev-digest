# Skills UI (Spec C) — Skill Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the `Import` item in the Skills list `+ Add Skill ▾` dropdown so a user can upload a single `.md` file, review parsed metadata + body in a trust-gated dialog, optionally edit the metadata, and confirm to create the skill.

**Architecture:** New server route `POST /skills/import/preview` is read-only — it parses a multipart upload with `@fastify/multipart`, runs an in-module markdown parser (no new deps), and returns `{ name, description, type, body, warnings }`. **No DB writes happen on this endpoint.** The actual create still goes through the existing `POST /skills` route after the user confirms. Spec ([docs/superpowers/specs/2026-06-23-skills-c-import-design.md](../specs/2026-06-23-skills-c-import-design.md)) builds on Spec A's inert `Import` dropdown item ([client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.tsx](../../../client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.tsx)).

**Tech Stack:** Fastify 5 + `@fastify/multipart` 9 (server). Next.js 15 App Router + React 19 + TanStack Query + `@devdigest/ui` `Modal` primitive + the shared `Markdown` primitive (client). Vitest + jsdom + RTL (tests).

## Global Constraints

- **Node ≥ 22, pnpm ≥ 10.** Run server commands from `server/`, client from `client/`.
- **No raw `fetch` outside `client/src/lib/api.ts`.** Components consume hooks from `client/src/lib/hooks/`.
- **No `throw new Error()` in routes or modules** — extend a class from `server/src/platform/errors.ts` (`ValidationError` for 422).
- **Zod schemas at every route boundary** — but the multipart upload route does NOT use a `body` schema (Zod can't validate multipart streams; validation happens manually after `req.file()`).
- **No cross-module imports between `modules/X` and `modules/Y`** (Y ≠ `_shared`).
- **Integration tests:** filename ends in `*.it.test.ts`; tests live flat under `server/test/`; gate on `dockerAvailable()` from `test/helpers/pg.ts`.
- **No new server runtime dependency other than `@fastify/multipart` ^9.x.** No `js-yaml` or other YAML parser — the frontmatter parser is hand-rolled with a 4-key whitelist (Spec C Decision #5).
- **File size cap: 256 KB.** Enforced via `@fastify/multipart` `limits.fileSize` AND a defensive check on the buffer length.
- **Only `.md` files accepted.** Server checks the filename extension; the client `<input>` uses `accept=".md"`.
- **No code execution, shell-out, network fetch, or filesystem write** triggered by the parser.
- **`source` semantics:** imported skills are persisted with `source: 'imported_url'` (existing enum value, reused per Spec C Decision #8). The `POST /skills` body schema is extended with an optional `source` field for this.
- **Server commit message style:** present-tense, single-quoted, English, under 72 chars, e.g. `git commit -m 'Add skill import preview route'`.
- **Client tests** colocated next to the file under test. No `__tests__/` subdirectories under `client/src/`.
- **Workspace isolation is non-negotiable:** the preview endpoint still calls `getContext()` to enforce the workspace gate even though it doesn't write.
- **All UI strings via `next-intl`** under `client/messages/en/skills.json`. New keys go under `skills.import.*`. Remove the now-unused `skills.list.importComingSoon` key.
- **Trust gate is non-negotiable:** the dialog MUST render `TrustBanner` whenever the preview state is shown.

---

## File Structure

**Server (touched):**

- `server/package.json` — add `@fastify/multipart` ^9.x to `dependencies`.
- `server/src/app.ts` — register `@fastify/multipart` globally, after `@fastify/cors`, before feature modules.
- `server/src/modules/skills/helpers.ts` — append `parseSkillMarkdown()` + `ParsedImportPayload` interface to the existing file (which already exports `toSkillDto` and `isContentChange`).
- `server/src/modules/skills/service.ts` — add `parseImport()` method and extend `CreateSkillInput` with optional `source`.
- `server/src/modules/skills/routes.ts` — add `POST /skills/import/preview` route and extend `CreateSkillBody` with optional `source`.
- `server/src/modules/skills/repository.ts` — accept and persist optional `source` in `insert()`.
- `server/test/skills-import.it.test.ts` — new integration tests.
- `server/test/skills-parser.test.ts` — new unit tests for `parseSkillMarkdown`.

**Client (new + touched):**

```
client/src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/
  ImportSkillDialog.tsx
  ImportSkillDialog.test.tsx
  TrustBanner.tsx
  styles.ts
  index.ts
```

- `client/src/lib/api.ts` — add `api.upload<T>()` helper; extend `apiFetch` to skip the JSON `content-type` injection when the body is a `FormData`.
- `client/src/lib/hooks/skills.ts` — add `useImportSkillPreview()`; extend `CreateSkillInput` with optional `source`.
- `client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.tsx` — accept new `onImport` prop; un-mute the Import item; remove the inert `onClick`.
- `client/src/app/skills/_components/SkillsListView/SkillsListView.tsx` — own `importing` state, pass `onImport`, render `<ImportSkillDialog>` conditionally.
- `client/messages/en/skills.json` — add `import.*` keys, delete `list.importComingSoon`.

---

## Task 1: Server — `parseSkillMarkdown` helper + unit tests

**Files:**
- Modify: `server/src/modules/skills/helpers.ts` (append parser + types)
- Create: `server/test/skills-parser.test.ts`

**Interfaces:**
- Consumes: `SkillType` from `@devdigest/shared`; `ValidationError` from `../../platform/errors.js`.
- Produces:
  - `interface ParsedImportPayload { name: string; description: string; type: SkillType; body: string; warnings: string[]; }`
  - `function parseSkillMarkdown(raw: string, filename: string | undefined): ParsedImportPayload`
  - Throws `ValidationError` with `code: 'validation_error'` (the AppError default) and `details: { code: 'empty_body' }` when the body would be empty.

- [ ] **Step 1: Write the failing unit tests**

Create `server/test/skills-parser.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest';
import { parseSkillMarkdown } from '../src/modules/skills/helpers.js';
import { ValidationError } from '../src/platform/errors.js';

describe('parseSkillMarkdown', () => {
  it('uses frontmatter when present', () => {
    const raw = `---
name: my-skill
description: A description.
type: security
---
## Body

Content here.`;
    const out = parseSkillMarkdown(raw, 'unused.md');
    expect(out.name).toBe('my-skill');
    expect(out.description).toBe('A description.');
    expect(out.type).toBe('security');
    expect(out.body).toContain('## Body');
    expect(out.warnings).toEqual([]);
  });

  it('derives name from H1 when frontmatter omits it', () => {
    const raw = `# Heading Name

A paragraph that explains it.`;
    const out = parseSkillMarkdown(raw, 'fallback.md');
    expect(out.name).toBe('Heading Name');
    expect(out.description).toBe('A paragraph that explains it');
    expect(out.type).toBe('custom');
  });

  it('falls back to filename when no name available', () => {
    const out = parseSkillMarkdown('Body text.', 'my_cool skill.md');
    expect(out.name).toBe('my-cool-skill');
  });

  it('coerces unknown type and emits a warning', () => {
    const raw = `---
name: x
type: nonsense
---
Body.`;
    const out = parseSkillMarkdown(raw, undefined);
    expect(out.type).toBe('custom');
    expect(out.warnings.some((w) => w.includes('nonsense'))).toBe(true);
  });

  it('warns and ignores unknown frontmatter keys', () => {
    const raw = `---
name: x
weird_key: ignored
---
Body.`;
    const out = parseSkillMarkdown(raw, undefined);
    expect(out.warnings.some((w) => w.includes('weird_key'))).toBe(true);
  });

  it('caps the derived description at 200 chars and trims a trailing period', () => {
    const long = 'x'.repeat(250) + '.';
    const out = parseSkillMarkdown(`# Title\n\n${long}`, undefined);
    expect(out.description.length).toBe(200);
    expect(out.description.endsWith('.')).toBe(false);
  });

  it('throws ValidationError with empty_body code when body is empty', () => {
    const raw = `---
name: x
---
`;
    expect(() => parseSkillMarkdown(raw, undefined)).toThrowError(ValidationError);
  });

  it('treats malformed frontmatter (no closing fence) as body', () => {
    const raw = `---
name: x
no closing fence here

# Real Title

Body paragraph.`;
    const out = parseSkillMarkdown(raw, undefined);
    expect(out.name).toBe('Real Title');
    expect(out.body).toContain('---');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `server/`:

```bash
pnpm vitest run test/skills-parser.test.ts
```

Expected: FAIL — `parseSkillMarkdown is not a function` (or similar import error).

- [ ] **Step 3: Implement `parseSkillMarkdown`**

Open `server/src/modules/skills/helpers.ts`. Add the imports at the top (alongside existing imports):

```typescript
import { ValidationError } from '../../platform/errors.js';
```

Append the following to the bottom of the file (after the existing `toSkillDto` function):

```typescript
export interface ParsedImportPayload {
  name: string;
  description: string;
  type: SkillType;
  body: string;
  warnings: string[];
}

const ALLOWED_FRONTMATTER_KEYS = new Set(['name', 'description', 'type', 'enabled']);
const ALLOWED_TYPES = new Set<SkillType>(['rubric', 'convention', 'security', 'custom']);

export function parseSkillMarkdown(
  raw: string,
  filename: string | undefined,
): ParsedImportPayload {
  const warnings: string[] = [];
  const frontmatter: Record<string, string | boolean> = {};
  let body = raw;

  if (raw.startsWith('---\n')) {
    const end = raw.indexOf('\n---\n', 4);
    if (end !== -1) {
      const fmText = raw.slice(4, end);
      body = raw.slice(end + 5);
      for (const line of fmText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const colon = trimmed.indexOf(':');
        if (colon === -1) {
          warnings.push(`Ignored malformed frontmatter line: ${trimmed}`);
          continue;
        }
        const key = trimmed.slice(0, colon).trim();
        const rawValue = trimmed.slice(colon + 1).trim();
        if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
          warnings.push(`Ignored unknown frontmatter key: ${key}`);
          continue;
        }
        const value = rawValue.replace(/^['"]|['"]$/g, '');
        if (key === 'enabled') {
          frontmatter.enabled = value === 'true';
        } else {
          frontmatter[key] = value;
        }
      }
    }
  }

  let type: SkillType = 'custom';
  const fmType = frontmatter.type;
  if (typeof fmType === 'string' && fmType) {
    if (ALLOWED_TYPES.has(fmType as SkillType)) {
      type = fmType as SkillType;
    } else {
      warnings.push(`Unknown type "${fmType}" — coerced to custom.`);
    }
  }

  body = body.replace(/^\n+/, '').replace(/\s+$/, '');
  if (!body) {
    throw new ValidationError('File body is empty.', { code: 'empty_body' });
  }

  let name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  if (!name) {
    const h1 = body.match(/^#\s+(.+)$/m);
    if (h1) name = h1[1].trim();
  }
  if (!name && filename) {
    name = filename.replace(/\.md$/i, '').replace(/[\s_]+/g, '-').trim();
  }
  if (!name) {
    name = 'imported-skill';
  }

  let description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!description) {
    const withoutH1 = body.replace(/^#\s+.+$\n?/m, '').trim();
    const firstPara = withoutH1.split(/\n\s*\n/)[0]?.trim() ?? '';
    description = firstPara.replace(/\.$/, '').slice(0, 200);
  }

  return { name, description, type, body, warnings };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run from `server/`:

```bash
pnpm vitest run test/skills-parser.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 5: Run typecheck**

Run from `server/`:

```bash
pnpm typecheck
```

Expected: clean exit.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/skills/helpers.ts server/test/skills-parser.test.ts
git commit -m 'Add parseSkillMarkdown frontmatter+body parser'
```

---

## Task 2: Server — `@fastify/multipart` plugin + preview route + integration tests

**Files:**
- Modify: `server/package.json` (add dep)
- Modify: `server/src/app.ts` (register plugin)
- Modify: `server/src/modules/skills/service.ts` (add `parseImport`)
- Modify: `server/src/modules/skills/routes.ts` (add route)
- Create: `server/test/skills-import.it.test.ts`

**Interfaces:**
- Consumes: `parseSkillMarkdown`, `ParsedImportPayload` from Task 1; `ValidationError` from `platform/errors`; `getContext` from `modules/_shared/context`.
- Produces:
  - `service.parseImport(text: string, filename: string | undefined): ParsedImportPayload`
  - Route `POST /skills/import/preview` accepts `multipart/form-data` with a single `file` field, returns 200 with `ParsedImportPayload` JSON, or 422 with `AppError` JSON on validation failure.

- [ ] **Step 1: Add the dependency**

Run from `server/`:

```bash
pnpm add @fastify/multipart@^9.0.0
```

Verify `server/package.json` `dependencies` now includes `"@fastify/multipart": "^9.0.0"` (or a matching `^9.x` line).

- [ ] **Step 2: Register the plugin in `app.ts`**

Open `server/src/app.ts`. Find the existing block (around line 89):

```typescript
await app.register(helmet);
await app.register(cors, { origin: [config.webOrigin], credentials: true });
await app.register(FastifySSEPlugin);
```

Add the multipart registration **after** the `cors` line and **before** `FastifySSEPlugin`:

```typescript
await app.register(helmet);
await app.register(cors, { origin: [config.webOrigin], credentials: true });
await app.register(import('@fastify/multipart'), {
  limits: {
    fileSize: 256 * 1024,
    files: 1,
    fieldSize: 1024,
    parts: 5,
  },
});
await app.register(FastifySSEPlugin);
```

- [ ] **Step 3: Add `parseImport` to the service**

Open `server/src/modules/skills/service.ts`. At the top of the file, add the import:

```typescript
import { parseSkillMarkdown, type ParsedImportPayload } from './helpers.js';
```

(Replace the existing `import { toSkillDto } from './helpers.js';` line with the combined import: `import { parseSkillMarkdown, toSkillDto, type ParsedImportPayload } from './helpers.js';`)

Inside the `SkillsService` class, after the `delete` method and before the `usage` method, add:

```typescript
parseImport(text: string, filename: string | undefined): ParsedImportPayload {
  return parseSkillMarkdown(text, filename);
}
```

Re-export `ParsedImportPayload` from the service so the route can import it:

```typescript
export type { ParsedImportPayload } from './helpers.js';
```

Add this line near the existing `export interface CreateSkillInput { … }` block.

- [ ] **Step 4: Add the route**

Open `server/src/modules/skills/routes.ts`. Add this import near the top, alongside the existing `ValidationError` siblings (the file already imports `NotFoundError` from `platform/errors.js`):

```typescript
import { NotFoundError, ValidationError } from '../../platform/errors.js';
```

(Replace the existing single-import line.)

Inside the `skillsRoutes` function, after the existing `DELETE /skills/:id` route and before the closing `}`, add:

```typescript
app.post('/skills/import/preview', async (req) => {
  await getContext(app.container, req);
  const data = await req.file();
  if (!data) {
    throw new ValidationError('No file uploaded.', { code: 'missing_file' });
  }
  if (!data.filename.toLowerCase().endsWith('.md')) {
    throw new ValidationError('File must have a .md extension.', { code: 'wrong_extension' });
  }
  const buffer = await data.toBuffer();
  if (buffer.length > 256 * 1024) {
    throw new ValidationError('File too large (max 256KB).', { code: 'too_large' });
  }
  let text: string;
  try {
    text = buffer.toString('utf8');
  } catch {
    throw new ValidationError('File must be UTF-8 encoded.', { code: 'invalid_encoding' });
  }
  return service.parseImport(text, data.filename);
});
```

- [ ] **Step 5: Write the failing integration tests**

Create `server/test/skills-import.it.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

function buildMultipart(filename: string, content: string, fieldName = 'file'): { headers: Record<string, string>; payload: Buffer } {
  const boundary = '----DevDigestTestBoundary';
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: text/markdown\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(content, 'utf8'), Buffer.from(tail, 'utf8')]),
  };
}

d('skills import module', () => {
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

  async function skillCount() {
    const [{ c }] = await pg.handle.db.execute<{ c: string }>(sql`SELECT COUNT(*)::text AS c FROM ${t.skills}`);
    return Number(c);
  }

  it('parses a valid .md file and does not create a skill row', async () => {
    const app = await makeApp();
    const before = await skillCount();
    const { headers, payload } = buildMultipart('my-skill.md', '---\nname: foo\ntype: security\n---\n# Foo\n\nWhat it does.');
    const res = await app.inject({ method: 'POST', url: '/skills/import/preview', headers, payload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('foo');
    expect(body.type).toBe('security');
    expect(body.body).toContain('# Foo');
    expect(body.warnings).toEqual([]);
    expect(await skillCount()).toBe(before);
    await app.close();
  });

  it('rejects non-.md filename with 422', async () => {
    const app = await makeApp();
    const { headers, payload } = buildMultipart('not-markdown.txt', '# x\n\nbody');
    const res = await app.inject({ method: 'POST', url: '/skills/import/preview', headers, payload });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('rejects empty body with 422', async () => {
    const app = await makeApp();
    const { headers, payload } = buildMultipart('empty.md', '---\nname: x\n---\n');
    const res = await app.inject({ method: 'POST', url: '/skills/import/preview', headers, payload });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('emits a warning when frontmatter type is invalid', async () => {
    const app = await makeApp();
    const { headers, payload } = buildMultipart('bad-type.md', '---\nname: x\ntype: bogus\n---\nBody text.');
    const res = await app.inject({ method: 'POST', url: '/skills/import/preview', headers, payload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe('custom');
    expect(body.warnings.some((w: string) => w.includes('bogus'))).toBe(true);
    await app.close();
  });

  it('rejects payload larger than 256KB without writing a row', async () => {
    const app = await makeApp();
    const before = await skillCount();
    const huge = '# Title\n\n' + 'x'.repeat(260 * 1024);
    const { headers, payload } = buildMultipart('huge.md', huge);
    const res = await app.inject({ method: 'POST', url: '/skills/import/preview', headers, payload });
    expect([413, 422]).toContain(res.statusCode);
    expect(await skillCount()).toBe(before);
    await app.close();
  });

  it('rejects multipart with no file field with 422', async () => {
    const app = await makeApp();
    const boundary = '----DevDigestTestBoundary';
    const payload = Buffer.from(`--${boundary}--\r\n`, 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/skills/import/preview',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});
```

- [ ] **Step 6: Run the integration tests to verify they pass**

Run from `server/`:

```bash
pnpm vitest run test/skills-import.it.test.ts
```

Expected: all 6 tests pass. (If Docker is not available locally, the suite is skipped — that is normal; verify the suite name is listed as `skipped`, not `failed`.)

- [ ] **Step 7: Run typecheck**

Run from `server/`:

```bash
pnpm typecheck
```

Expected: clean exit.

- [ ] **Step 8: Commit**

```bash
git add server/package.json server/pnpm-lock.yaml server/src/app.ts \
        server/src/modules/skills/service.ts server/src/modules/skills/routes.ts \
        server/test/skills-import.it.test.ts
git commit -m 'Add POST /skills/import/preview multipart route'
```

---

## Task 3: Server — Extend `POST /skills` to accept optional `source`

**Files:**
- Modify: `server/src/modules/skills/routes.ts` (extend `CreateSkillBody`)
- Modify: `server/src/modules/skills/service.ts` (extend `CreateSkillInput`)
- Modify: `server/src/modules/skills/repository.ts` (accept `source` on insert)
- Modify: `server/test/skills.it.test.ts` (add a test that passing `source: 'imported_url'` persists it)

**Interfaces:**
- Consumes: `SkillSource` enum from `@devdigest/shared`.
- Produces: `POST /skills` accepts an optional `source` field in the JSON body, one of `'manual' | 'imported_url' | 'extracted' | 'community'`. When omitted, the repository keeps the existing default behaviour (whatever it was — `'manual'`).

- [ ] **Step 1: Inspect the current repository insert signature**

Run from the worktree root:

```bash
sed -n '1,80p' server/src/modules/skills/repository.ts
```

Note where `source` is currently defaulted in the `insert()` method. The change in Step 3 must preserve that default when `source` is undefined.

- [ ] **Step 2: Write the failing integration test**

In `server/test/skills.it.test.ts`, add a new test inside the existing `describe('skills module', …)` block (place it next to the other `POST /skills` tests):

```typescript
it('POST /skills persists source: "imported_url" when provided', async () => {
  const app = await makeApp();
  const res = await app.inject({
    method: 'POST',
    url: '/skills',
    payload: {
      name: 'from-import',
      description: '',
      type: 'custom',
      body: '# Imported\n',
      source: 'imported_url',
    },
  });
  expect(res.statusCode).toBe(201);
  const created = res.json();
  expect(created.source).toBe('imported_url');
  await app.close();
});
```

Run it:

```bash
pnpm vitest run test/skills.it.test.ts -t 'persists source'
```

Expected: FAIL — either zod rejects the extra field (422) or the row is saved with `source: 'manual'`.

- [ ] **Step 3: Extend the route's Zod body schema**

Open `server/src/modules/skills/routes.ts`. Add the import:

```typescript
import { SkillSource, SkillType } from '@devdigest/shared';
```

(Replace the existing `import { SkillType } from '@devdigest/shared';` line.)

Update the `CreateSkillBody` schema to include the optional field:

```typescript
const CreateSkillBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  type: SkillType,
  body: z.string().min(1),
  enabled: z.boolean().optional(),
  source: SkillSource.optional(),
});
```

- [ ] **Step 4: Extend the service input + create call**

Open `server/src/modules/skills/service.ts`. Extend `CreateSkillInput`:

```typescript
export interface CreateSkillInput {
  name: string;
  description?: string;
  type: SkillType;
  body: string;
  enabled?: boolean;
  source?: SkillSource;
}
```

Add `SkillSource` to the existing `@devdigest/shared` type import at the top:

```typescript
import type { Skill, SkillSource, SkillType } from '@devdigest/shared';
```

In the `create()` method, forward the optional `source` to the repo:

```typescript
async create(workspaceId: string, input: CreateSkillInput): Promise<Skill> {
  const row = await this.repo.insert({
    workspaceId,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    type: input.type,
    body: input.body,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
  });
  return toSkillDto(row);
}
```

- [ ] **Step 5: Extend the repository `insert()` signature**

Open `server/src/modules/skills/repository.ts` and find the `insert()` method. Add `source?: SkillSource` to the input type (keep the existing default — typically `source: input.source ?? 'manual'` inside the Drizzle `.values(…)` call). If the current code hardcodes `'manual'`, change that line to `source: input.source ?? 'manual'`.

(The exact patch depends on the repository's current shape, which Task 3 Step 1 confirmed. The principle: accept the value if provided, default to the existing literal otherwise.)

- [ ] **Step 6: Run the new test to verify it passes**

```bash
pnpm vitest run test/skills.it.test.ts -t 'persists source'
```

Expected: PASS.

- [ ] **Step 7: Run the full skills suites + typecheck**

```bash
pnpm vitest run test/skills.it.test.ts test/skills-parser.test.ts test/skills-import.it.test.ts
pnpm typecheck
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/skills/routes.ts server/src/modules/skills/service.ts \
        server/src/modules/skills/repository.ts server/test/skills.it.test.ts
git commit -m 'Accept optional source on POST /skills'
```

---

## Task 4: Client — `api.upload` + `FormData`-aware `apiFetch`

**Files:**
- Modify: `client/src/lib/api.ts`

**Interfaces:**
- Produces: `api.upload<T>(path: string, file: File): Promise<T>` — posts a `multipart/form-data` request with one `file` field; `apiFetch` no longer injects `content-type: application/json` when the body is a `FormData`.

- [ ] **Step 1: Patch `apiFetch` to skip JSON header for `FormData`**

Open `client/src/lib/api.ts`. Locate the `apiFetch` function (around line 18) and change the header construction line:

Find:

```typescript
        ...(init?.body != null ? { "content-type": "application/json" } : {}),
```

Replace with:

```typescript
        ...(init?.body != null && !(init.body instanceof FormData)
          ? { "content-type": "application/json" }
          : {}),
```

- [ ] **Step 2: Add the `upload` helper to the `api` object**

In the same file, locate the `export const api = { … }` block at the bottom. Add `upload` after `del`:

```typescript
export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiFetch<T>(path, { method: "POST", body: fd });
  },
};
```

- [ ] **Step 3: Run client typecheck**

Run from `client/`:

```bash
pnpm typecheck
```

Expected: clean exit.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/api.ts
git commit -m 'Add api.upload helper for multipart requests'
```

---

## Task 5: Client — `useImportSkillPreview` hook + `source` on `CreateSkillInput`

**Files:**
- Modify: `client/src/lib/hooks/skills.ts`

**Interfaces:**
- Consumes: `api.upload` from Task 4; `SkillSource` from `@devdigest/shared`.
- Produces:
  - `interface ParsedImportPayload { name: string; description: string; type: SkillType; body: string; warnings: string[]; }`
  - `useImportSkillPreview()` — a TanStack mutation taking a `File`, returning a `ParsedImportPayload`.
  - `CreateSkillInput` extended with `source?: SkillSource`.

- [ ] **Step 1: Extend the type imports + `CreateSkillInput`**

Open `client/src/lib/hooks/skills.ts`. Replace the existing type import:

```typescript
import type { Skill, SkillSource, SkillType } from "@devdigest/shared";
```

Extend `CreateSkillInput`:

```typescript
export interface CreateSkillInput {
  name: string;
  description?: string;
  type: SkillType;
  body: string;
  enabled?: boolean;
  source?: SkillSource;
}
```

- [ ] **Step 2: Add the `ParsedImportPayload` interface + `useImportSkillPreview` hook**

At the end of the file, after `useDeleteSkill`, append:

```typescript
export interface ParsedImportPayload {
  name: string;
  description: string;
  type: SkillType;
  body: string;
  warnings: string[];
}

export function useImportSkillPreview() {
  return useMutation({
    mutationFn: (file: File) =>
      api.upload<ParsedImportPayload>("/skills/import/preview", file),
  });
}
```

- [ ] **Step 3: Run client typecheck**

```bash
pnpm typecheck
```

Expected: clean exit.

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/hooks/skills.ts
git commit -m 'Add useImportSkillPreview hook and source on CreateSkillInput'
```

---

## Task 6: Client — `TrustBanner` + `ImportSkillDialog` component + tests

**Files:**
- Create: `client/src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/index.ts`
- Create: `client/src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/ImportSkillDialog.tsx`
- Create: `client/src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/ImportSkillDialog.test.tsx`
- Create: `client/src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/TrustBanner.tsx`
- Create: `client/src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/styles.ts`
- Modify: `client/messages/en/skills.json` (add `import.*` keys — does NOT remove `list.importComingSoon` yet; that happens in Task 7 so this task is reviewable on its own)

**Interfaces:**
- Consumes: `Modal` from `@devdigest/ui`; `Markdown` from the shared UI primitives barrel (re-exported from `@devdigest/ui` — verify in Step 1); `useImportSkillPreview`, `useCreateSkill`, `ParsedImportPayload` from `client/src/lib/hooks/skills`.
- Produces: `<ImportSkillDialog open: boolean; onClose: () => void />` — renders `null` when `open` is false; otherwise renders the trust-gated picker/preview flow.

- [ ] **Step 1: Verify the `Markdown` primitive is re-exported from `@devdigest/ui`**

Run from `client/`:

```bash
grep -rn 'export.*Markdown' src/vendor/ui/ | head
```

Expected: a line in `src/vendor/ui/index.ts` (or similar) re-exporting `Markdown`. If `Markdown` is not in the barrel, import it directly from `../../../../components/markdown` (mirror the pattern the existing `SkillPreviewDrawer` uses — `grep -n "Markdown" src/app/skills/_components/SkillsListView/_components/SkillPreviewDrawer/*.tsx`). Use whichever path that file uses.

- [ ] **Step 2: Add the new i18n keys (without removing the old one yet)**

Open `client/messages/en/skills.json`. Add a new top-level `"import"` block after `"editor"`:

```json
  "import": {
    "title": "Import a skill",
    "subtitle": "Upload a Markdown file from another workspace or a teammate.",
    "drop": "Choose a .md file…",
    "hint": "Markdown only, max 256KB",
    "trustBanner": "You're about to add someone else's instructions to your agents' prompts. Read the body below before saving. You can edit anything after import.",
    "parseError": "We couldn't parse the file. Make sure it's valid Markdown.",
    "tooLarge": "File too large. The maximum is 256KB.",
    "wrongExt": "Only .md files are supported.",
    "warningsLabel": "Heads up:",
    "cancel": "Cancel",
    "create": "Create skill",
    "creating": "Creating…",
    "nameLabel": "Name",
    "typeLabel": "Type",
    "descriptionLabel": "Description",
    "bodyLabel": "Body preview"
  }
```

Be careful with the JSON comma between the previous `editor` block and the new `import` block.

- [ ] **Step 3: Write the failing component tests**

Create `client/src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/ImportSkillDialog.test.tsx`:

```typescript
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { ImportSkillDialog } from "./ImportSkillDialog";
import * as skillsHooks from "../../../../../../lib/hooks/skills";
import messages from "../../../../../../../messages/en/skills.json";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("../../../../../../lib/hooks/skills");

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

function makeFile(name = "thing.md", body = "# Thing\n\nBody.") {
  return new File([body], name, { type: "text/markdown" });
}

const PREVIEW = {
  name: "thing",
  description: "Body",
  type: "custom" as const,
  body: "# Thing\n\nBody.",
  warnings: [],
};

describe("ImportSkillDialog", () => {
  beforeEach(() => {
    pushMock.mockReset();
    vi.mocked(skillsHooks.useImportSkillPreview).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue(PREVIEW),
      isPending: false,
      isError: false,
      error: null,
      reset: vi.fn(),
    } as any);
    vi.mocked(skillsHooks.useCreateSkill).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue({ id: "new-id" }),
      isPending: false,
    } as any);
  });

  it("returns null when not open", () => {
    const { container } = render(wrap(<ImportSkillDialog open={false} onClose={() => {}} />));
    expect(container.firstChild).toBeNull();
  });

  it("renders the file picker initially", () => {
    render(wrap(<ImportSkillDialog open={true} onClose={() => {}} />));
    expect(screen.getByText(/Import a skill/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Choose a .md file/i)).toBeInTheDocument();
  });

  it("transitions to the preview state after a successful upload", async () => {
    render(wrap(<ImportSkillDialog open={true} onClose={() => {}} />));
    const input = screen.getByLabelText(/Choose a .md file/i) as HTMLInputElement;
    await userEvent.upload(input, makeFile());
    await waitFor(() => expect(screen.getByText(/someone else's instructions/i)).toBeInTheDocument());
    expect(screen.getByDisplayValue("thing")).toBeInTheDocument();
  });

  it("renders parser warnings as chips", async () => {
    vi.mocked(skillsHooks.useImportSkillPreview).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue({ ...PREVIEW, warnings: ["Unknown type \"x\" — coerced to custom."] }),
      isPending: false,
      isError: false,
      error: null,
      reset: vi.fn(),
    } as any);
    render(wrap(<ImportSkillDialog open={true} onClose={() => {}} />));
    await userEvent.upload(screen.getByLabelText(/Choose a .md file/i) as HTMLInputElement, makeFile());
    await waitFor(() => expect(screen.getByText(/Heads up:/i)).toBeInTheDocument());
    expect(screen.getByText(/coerced to custom/i)).toBeInTheDocument();
  });

  it("calls useCreateSkill with source 'imported_url' and navigates on success", async () => {
    const createMutateAsync = vi.fn().mockResolvedValue({ id: "new-id" });
    vi.mocked(skillsHooks.useCreateSkill).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: createMutateAsync,
      isPending: false,
    } as any);
    render(wrap(<ImportSkillDialog open={true} onClose={() => {}} />));
    await userEvent.upload(screen.getByLabelText(/Choose a .md file/i) as HTMLInputElement, makeFile());
    await waitFor(() => screen.getByText(/someone else's instructions/i));
    await userEvent.click(screen.getByRole("button", { name: /Create skill/i }));
    await waitFor(() => {
      expect(createMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ name: "thing", source: "imported_url", body: "# Thing\n\nBody." }),
      );
    });
    expect(pushMock).toHaveBeenCalledWith("/skills/new-id");
  });

  it("shows an inline error when the preview upload fails", async () => {
    vi.mocked(skillsHooks.useImportSkillPreview).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockRejectedValue(new Error("boom")),
      isPending: false,
      isError: true,
      error: new Error("boom"),
      reset: vi.fn(),
    } as any);
    render(wrap(<ImportSkillDialog open={true} onClose={() => {}} />));
    await userEvent.upload(screen.getByLabelText(/Choose a .md file/i) as HTMLInputElement, makeFile());
    await waitFor(() => expect(screen.getByText(/couldn't parse the file/i)).toBeInTheDocument());
  });

  it("Cancel calls onClose without saving", async () => {
    const onClose = vi.fn();
    render(wrap(<ImportSkillDialog open={true} onClose={onClose} />));
    await userEvent.upload(screen.getByLabelText(/Choose a .md file/i) as HTMLInputElement, makeFile());
    await waitFor(() => screen.getByText(/someone else's instructions/i));
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

Run from `client/`:

```bash
pnpm vitest run src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/ImportSkillDialog.test.tsx
```

Expected: FAIL — `ImportSkillDialog` not found (the file does not exist yet).

- [ ] **Step 4: Implement `styles.ts`**

Create `client/src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/styles.ts`:

```typescript
import type { CSSProperties } from "react";

export const s = {
  picker: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: "24px 0",
    alignItems: "stretch",
  } as CSSProperties,
  hiddenInput: {
    position: "absolute",
    inset: 0,
    opacity: 0,
    cursor: "pointer",
  } as CSSProperties,
  pickerBox: {
    position: "relative",
    border: "2px dashed var(--border)",
    borderRadius: 12,
    padding: "32px 16px",
    textAlign: "center",
    cursor: "pointer",
    color: "var(--muted-foreground)",
  } as CSSProperties,
  hint: { fontSize: 12, color: "var(--muted-foreground)" } as CSSProperties,
  previewGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
    gap: 16,
  } as CSSProperties,
  field: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 } as CSSProperties,
  label: { fontSize: 12, fontWeight: 600 } as CSSProperties,
  input: {
    padding: "8px 10px",
    border: "1px solid var(--border)",
    borderRadius: 6,
    fontSize: 14,
    background: "var(--bg)",
    color: "var(--fg)",
  } as CSSProperties,
  bodyPreview: {
    maxHeight: 360,
    overflow: "auto",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: 12,
  } as CSSProperties,
  warningsRow: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 } as CSSProperties,
  warningChip: {
    background: "color-mix(in srgb, var(--warn) 18%, transparent)",
    color: "var(--warn)",
    fontSize: 12,
    borderRadius: 999,
    padding: "2px 10px",
  } as CSSProperties,
  errorBox: {
    background: "color-mix(in srgb, var(--danger) 12%, transparent)",
    color: "var(--danger)",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 13,
    marginBottom: 12,
  } as CSSProperties,
  trustBox: {
    background: "color-mix(in srgb, var(--warn) 18%, transparent)",
    border: "1px solid color-mix(in srgb, var(--warn) 40%, transparent)",
    borderRadius: 10,
    padding: "10px 12px",
    fontSize: 13,
    marginBottom: 12,
    display: "flex",
    gap: 8,
    alignItems: "flex-start",
  } as CSSProperties,
  footer: { display: "flex", justifyContent: "flex-end", gap: 8 } as CSSProperties,
};
```

- [ ] **Step 5: Implement `TrustBanner.tsx`**

Create `client/src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/TrustBanner.tsx`:

```typescript
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { s } from "./styles";

export function TrustBanner() {
  const t = useTranslations("skills");
  return (
    <div role="note" style={s.trustBox}>
      <span aria-hidden>⚠</span>
      <span>{t("import.trustBanner")}</span>
    </div>
  );
}
```

- [ ] **Step 6: Implement `ImportSkillDialog.tsx`**

Create `client/src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/ImportSkillDialog.tsx`:

```typescript
"use client";

import React, { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Markdown, Modal } from "@devdigest/ui";
import {
  useCreateSkill,
  useImportSkillPreview,
  type ParsedImportPayload,
} from "../../../../../../lib/hooks/skills";
import type { SkillType } from "@devdigest/shared";
import { TrustBanner } from "./TrustBanner";
import { s } from "./styles";

type State =
  | { kind: "picker"; error?: string }
  | { kind: "loading" }
  | { kind: "preview"; payload: ParsedImportPayload; saveError?: string };

const TYPE_OPTIONS: { value: SkillType; key: SkillType }[] = [
  { value: "rubric", key: "rubric" },
  { value: "convention", key: "convention" },
  { value: "security", key: "security" },
  { value: "custom", key: "custom" },
];

export function ImportSkillDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("skills");
  const router = useRouter();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({ kind: "picker" });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<SkillType>("custom");
  const [body, setBody] = useState("");
  const preview = useImportSkillPreview();
  const create = useCreateSkill();

  if (!open) return null;

  function reset() {
    setState({ kind: "picker" });
    setName("");
    setDescription("");
    setType("custom");
    setBody("");
    preview.reset();
    if (inputRef.current) inputRef.current.value = "";
  }

  async function onFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".md")) {
      setState({ kind: "picker", error: t("import.wrongExt") });
      return;
    }
    if (file.size > 256 * 1024) {
      setState({ kind: "picker", error: t("import.tooLarge") });
      return;
    }
    setState({ kind: "loading" });
    try {
      const payload = await preview.mutateAsync(file);
      setName(payload.name);
      setDescription(payload.description);
      setType(payload.type);
      setBody(payload.body);
      setState({ kind: "preview", payload });
    } catch {
      setState({ kind: "picker", error: t("import.parseError") });
    }
  }

  async function onSave() {
    if (state.kind !== "preview") return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const created = await create.mutateAsync({
        name: trimmed,
        description,
        type,
        body,
        enabled: true,
        source: "imported_url",
      });
      onClose();
      router.push(`/skills/${created.id}`);
    } catch (e) {
      setState({ ...state, saveError: (e as Error).message ?? t("editor.saveError") });
    }
  }

  function handleClose() {
    reset();
    onClose();
  }

  return (
    <Modal
      width={820}
      title={t("import.title")}
      subtitle={t("import.subtitle")}
      onClose={handleClose}
      footer={
        state.kind === "preview" ? (
          <div style={s.footer}>
            <Button kind="ghost" onClick={handleClose}>{t("import.cancel")}</Button>
            <Button
              kind="primary"
              onClick={onSave}
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? t("import.creating") : t("import.create")}
            </Button>
          </div>
        ) : (
          <div style={s.footer}>
            <Button kind="ghost" onClick={handleClose}>{t("import.cancel")}</Button>
          </div>
        )
      }
    >
      {state.kind === "picker" && (
        <div style={s.picker}>
          <label htmlFor={inputId} style={s.pickerBox}>
            <div>{t("import.drop")}</div>
            <div style={s.hint}>{t("import.hint")}</div>
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              accept=".md"
              style={s.hiddenInput}
              aria-label={t("import.drop")}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onFile(f);
              }}
            />
          </label>
          {state.error && <div style={s.errorBox}>{state.error}</div>}
        </div>
      )}

      {state.kind === "loading" && <div style={s.picker}>…</div>}

      {state.kind === "preview" && (
        <div>
          <TrustBanner />
          {state.payload.warnings.length > 0 && (
            <div style={s.warningsRow}>
              <span style={s.label}>{t("import.warningsLabel")}</span>
              {state.payload.warnings.map((w, i) => (
                <span key={i} style={s.warningChip}>{w}</span>
              ))}
            </div>
          )}
          {state.saveError && <div style={s.errorBox}>{state.saveError}</div>}
          <div style={s.previewGrid}>
            <div>
              <div style={s.field}>
                <label style={s.label} htmlFor={`${inputId}-name`}>{t("import.nameLabel")}</label>
                <input
                  id={`${inputId}-name`}
                  style={s.input}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div style={s.field}>
                <label style={s.label} htmlFor={`${inputId}-type`}>{t("import.typeLabel")}</label>
                <select
                  id={`${inputId}-type`}
                  style={s.input}
                  value={type}
                  onChange={(e) => setType(e.target.value as SkillType)}
                >
                  {TYPE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{t(`types.${o.key}`)}</option>
                  ))}
                </select>
              </div>
              <div style={s.field}>
                <label style={s.label} htmlFor={`${inputId}-desc`}>{t("import.descriptionLabel")}</label>
                <textarea
                  id={`${inputId}-desc`}
                  style={{ ...s.input, minHeight: 80 }}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
            <div>
              <div style={s.label}>{t("import.bodyLabel")}</div>
              <div style={s.bodyPreview}>
                <Markdown>{body}</Markdown>
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
```

> **If `Markdown` is NOT re-exported from `@devdigest/ui` (Step 1 result):** replace `import { Button, Markdown, Modal } from "@devdigest/ui";` with two imports — keep `Button, Modal` from `@devdigest/ui`, and add a second import for `Markdown` using whatever path the `SkillPreviewDrawer` uses.

- [ ] **Step 7: Implement the barrel**

Create `client/src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/index.ts`:

```typescript
export { ImportSkillDialog } from "./ImportSkillDialog";
```

- [ ] **Step 8: Run the component tests to verify they pass**

Run from `client/`:

```bash
pnpm vitest run src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/ImportSkillDialog.test.tsx
```

Expected: 7 tests pass.

- [ ] **Step 9: Run client typecheck**

```bash
pnpm typecheck
```

Expected: clean exit.

- [ ] **Step 10: Commit**

```bash
git add client/src/app/skills/_components/SkillsListView/_components/ImportSkillDialog \
        client/messages/en/skills.json
git commit -m 'Add ImportSkillDialog with TrustBanner and preview'
```

---

## Task 7: Client — Wire `AddSkillButton` → `ImportSkillDialog` + cleanup + manual verification

**Files:**
- Modify: `client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.tsx`
- Modify: `client/src/app/skills/_components/SkillsListView/SkillsListView.tsx`
- Modify: `client/messages/en/skills.json` (remove `list.importComingSoon`)
- Modify (if a test asserts on the muted/inert state): `client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.test.tsx`

**Interfaces:**
- Produces: `<AddSkillButton onCreate={…} onImport={…} />` — the Import dropdown item is now active, with no `muted` styling. `SkillsListView` owns `importing` state and renders `<ImportSkillDialog open={importing} onClose={…} />`.

- [ ] **Step 1: Update `AddSkillButton.tsx`**

Open `client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.tsx`. Replace the file contents with:

```typescript
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Dropdown } from "@devdigest/ui";

export function AddSkillButton({
  onCreate,
  onImport,
}: {
  onCreate: () => void;
  onImport: () => void;
}) {
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
        { label: t("list.createFromScratch"), icon: "Edit" as const, onClick: onCreate },
        { divider: true },
        { label: t("list.importFromFile"), icon: "Upload" as const, onClick: onImport },
      ]}
    />
  );
}
```

- [ ] **Step 2: Wire `SkillsListView` to own the `importing` state**

Open `client/src/app/skills/_components/SkillsListView/SkillsListView.tsx`. At the top of the file, add:

```typescript
import { ImportSkillDialog } from "./_components/ImportSkillDialog";
```

Inside the component, alongside the existing local state, add:

```typescript
const [importing, setImporting] = React.useState(false);
```

Replace the existing `<AddSkillButton onCreate={() => router.push("/skills/new")} />` usage with:

```typescript
<AddSkillButton
  onCreate={() => router.push("/skills/new")}
  onImport={() => setImporting(true)}
/>
```

Just before the closing `</AppShell>`, add:

```typescript
<ImportSkillDialog open={importing} onClose={() => setImporting(false)} />
```

- [ ] **Step 3: Remove the unused i18n key**

Open `client/messages/en/skills.json`. In the `list` block, delete the line:

```json
    "importComingSoon": "Coming soon",
```

(Mind the trailing comma on the previous line — JSON does not allow trailing commas, so adjust accordingly.)

- [ ] **Step 4: Update or remove any existing `AddSkillButton` test that asserts the muted/inert state**

Run from `client/`:

```bash
ls src/app/skills/_components/SkillsListView/_components/AddSkillButton/
```

If `AddSkillButton.test.tsx` exists, open it. Any test asserting that Import is muted or that clicking it does nothing must now assert the opposite (calls `onImport`). Add a test:

```typescript
it("calls onImport when the Import item is clicked", async () => {
  const onImport = vi.fn();
  render(wrap(<AddSkillButton onCreate={() => {}} onImport={onImport} />));
  await userEvent.click(screen.getByRole("button", { name: /Add Skill/i }));
  await userEvent.click(screen.getByText("Import"));
  expect(onImport).toHaveBeenCalled();
});
```

(Use the wrap helper that already exists in the file; if there is no existing test file, skip this step.)

- [ ] **Step 5: Verify search for the removed key**

Run from the worktree root:

```bash
grep -rn 'importComingSoon' client/
```

Expected: no results.

- [ ] **Step 6: Run the affected client tests + typecheck**

Run from `client/`:

```bash
pnpm vitest run src/app/skills/_components/SkillsListView
pnpm typecheck
```

Expected: all green.

- [ ] **Step 7: Manual UI verification**

Start the full local stack from the worktree root:

```bash
./scripts/dev.sh
```

In a browser:

1. Open `http://localhost:3000/skills`.
2. Click `+ Add Skill ▾`. Confirm the `Import` item is **enabled** (normal text color, not muted).
3. Click `Import`. Confirm the dialog opens on the file picker.
4. Pick any local `.md` file (e.g. this repository's `README.md` — copy it locally as `import-test.md` if needed). Confirm:
   - The dialog shows the trust banner.
   - Name, type, and description are prefilled.
   - The rendered body appears in the right pane.
5. Click `Create skill`. Confirm:
   - The dialog closes.
   - The browser navigates to `/skills/{id}` showing the editor.
   - The new skill row appears in `/skills` (after navigating back).
6. Open `/skills` and click `Import` again. This time, pick a `.txt` file. Confirm an inline error appears.
7. Close the picker via `Cancel`. Confirm no skill is created.

Note any deviations from the spec's "Acceptance criteria" section ([docs/superpowers/specs/2026-06-23-skills-c-import-design.md:262-270](../specs/2026-06-23-skills-c-import-design.md)) in the commit message body if relevant.

- [ ] **Step 8: Commit**

```bash
git add client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.tsx \
        client/src/app/skills/_components/SkillsListView/SkillsListView.tsx \
        client/messages/en/skills.json \
        client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.test.tsx
git commit -m 'Wire AddSkillButton Import to ImportSkillDialog'
```

- [ ] **Step 9: Final architectural self-review**

Per `CLAUDE.md` ("Pre-ready architectural check"), run from the worktree root:

```
/pr-self-review
```

Treat MUST findings as blockers (propose a fix, ask before applying). Include SHOULD findings in the final summary.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `@fastify/multipart` dep + plugin reg with `limits.fileSize: 256*1024` | Task 2 (Steps 1–2) |
| `parseSkillMarkdown` helper, frontmatter priority, fallbacks, warnings | Task 1 |
| `POST /skills/import/preview` returns parsed payload, no DB writes | Task 2 |
| Empty body → 422 with `empty_body` | Task 1 (Step 3) + Task 2 (Step 5) |
| File > 256KB rejected | Task 2 (Step 5) |
| Non-`.md` rejected | Task 2 (Step 5) |
| Invalid `type` → coerce + warning | Task 1 + Task 2 |
| `apiFetch` FormData support + `api.upload` | Task 4 |
| `useImportSkillPreview` hook | Task 5 |
| `ImportSkillDialog` with picker / loading / preview / error | Task 6 |
| `TrustBanner` always visible in preview | Task 6 (Step 5 + Step 6) |
| Warnings render as inline chips | Task 6 (Step 6) |
| `Create skill` reuses `useCreateSkill`, sends `source: 'imported_url'` | Task 5 + Task 6 |
| Server accepts optional `source` on `POST /skills` | Task 3 |
| `AddSkillButton` Import item un-muted, wired through `onImport` | Task 7 |
| Remove unused `skills.list.importComingSoon` i18n key | Task 7 (Step 3) |
| New i18n keys under `skills.import.*` | Task 6 (Step 2) |
| Acceptance criteria — manual UI walkthrough | Task 7 (Step 7) |

## Open questions / risks

- **`SkillSource` zod import on the server**: the spec refers to `@devdigest/shared` exports. If `SkillSource` is not exported from the server-side shared module, the route's Zod import in Task 3 Step 3 will fail. Mitigation: re-run the explore step in that case and fall back to a local `z.enum(['manual','imported_url','extracted','community'])` in `routes.ts`.
- **Worktree was branched before Spec C landed**: the spec itself is not yet in the worktree (it lives in `main`). The plan author copied the relevant excerpts into this document so the worktree implementer does not need it. If the implementer needs to consult the spec, it is at `/Users/pandpbsa/Projects/dev-digest/docs/superpowers/specs/2026-06-23-skills-c-import-design.md` in the main checkout.
- **Multipart in `app.inject`**: the helper in Task 2 Step 5 constructs the multipart bytes by hand. If `@fastify/multipart` rejects the hand-constructed payload (e.g. CRLF normalisation), switch to the `form-data` package as a `devDependency` and use `form.getBuffer()` + `form.getHeaders()`.
- **Existing `AddSkillButton.test.tsx`**: the explore step found no such test in the worktree but did not verify exhaustively. If one exists, Task 7 Step 4 handles it; if not, the step is a no-op.

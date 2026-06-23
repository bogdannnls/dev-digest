# PR Overview — Slice D (Intent) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to execute this plan task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Ship the Intent block of the new PR Overview tab. Given a PR, derive a single-sentence restated goal, in-scope / out-of-scope bullet lists, and 1–3 risk-area chips via a structured LLM call, cache the result keyed by `(head_sha, body_hash)`, and render an `IntentCard` that handles the cold (`computing`) → warm (`ready`) lifecycle over SSE.

**Architecture:** New `server/src/modules/overview/` Fastify module (intent-only in this slice; Brief / Blast / Prior PRs land in Slices A–C). Pure extractor (`intent/extract.ts`) lives behind `Container.llm(provider).completeStructured(...)` — same shape conventions uses. Service (`intent/service.ts`) is the sole writer: reads `pr_intent` row, compares freshness key, on miss enqueues a `platform/jobs` job whose handler calls the extractor, writes the row, and emits `done` on `container.runBus`. Routes expose `GET /intent` (sync read), `GET /intent/stream` (SSE), `POST /intent/refresh` (force recompute). Client owns a `useOverviewIntent(prId)` hook that branches on the response status and, while computing, subscribes to the SSE stream and invalidates the query on `done`.

**Tech Stack:** Fastify 5 + `fastify-type-provider-zod`, Drizzle ORM (Postgres 16 + pgvector), Zod, `@devdigest/reviewer-core` structured-output, `platform/jobs` (p-queue) + `platform/sse` (RunBus), Next 15 / React 19 / TanStack Query, RTL + Vitest.

## Global constraints

- Migrations are **append-only**. Never edit an applied `.sql` file in `server/src/db/migrations/`. Generate with `pnpm db:generate` and hand-edit if needed.
- Migrations are **not auto-applied on boot** — run `pnpm db:migrate` from `server/` before integration tests that don't go through `startPg()`.
- Single writer rule: only `overview/intent/service.ts` writes `pr_intent`. No other module reads-then-writes the row.
- LLM provider is resolved **per request** via `resolveFeatureModel(container, workspaceId, 'review_intent')` → `container.llm(provider)`. Never cache the provider across requests, never hard-code a model.
- Errors in route handlers must extend types from `server/src/platform/errors.ts`. No bare `throw new Error()`.
- SSE writes go through `container.runBus` + `reply.sse(...)`. Never touch `reply.raw`.
- Adapter mocks (`server/src/adapters/mocks.ts`) are for tests only — never import from production code.
- Integration tests: suffix `*.it.test.ts`; import the DB fixture from `server/test/helpers/pg.ts`.
- Shared contracts live in **both** `server/src/vendor/shared/contracts/` **and** `client/src/vendor/shared/contracts/`. Keep them byte-identical after every change.
- After each server task: `pnpm --dir server typecheck` then the touched vitest file. After each client task: `pnpm --dir client typecheck` then the touched vitest file. Commit only when green.

## File structure

**New files (server):**
- `server/src/db/migrations/0015_pr_intent_overview.sql` — append-only migration extending `pr_intent` with 8 columns.
- `server/src/modules/overview/routes.ts` — Fastify plugin exposing 3 intent endpoints (extra blocks land alongside in other slices).
- `server/src/modules/overview/intent/extract.ts` — pure LLM extractor; `extractIntent(container, workspaceId, input) => Promise<PrIntentDto>`.
- `server/src/modules/overview/intent/extract.test.ts` — unit test using `MockLLMProvider`.
- `server/src/modules/overview/intent/service.ts` — orchestrator: read row, compare freshness, enqueue job, write row, emit SSE.
- `server/src/modules/overview/intent/service.test.ts` — freshness-key unit test (in-memory DB stub or real `db` via `startPg`).
- `server/src/modules/overview/intent/repository.ts` — Drizzle row I/O (`get`, `upsert`).
- `server/src/modules/overview/routes.it.test.ts` — integration: cold compute, warm hit, refresh, SSE.
- `docs/agent-prompts/intent-extractor.md` — system prompt (loaded via `loadPromptTemplate`).

**New files (client):**
- `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/IntentCard.tsx` — card component.
- `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/IntentCard.test.tsx` — RTL tests (ready / computing / error / refresh).
- `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/index.ts` — barrel re-export.
- `client/src/lib/hooks/overview.ts` — `useOverviewIntent(prId)` + `useRefreshOverviewIntent(prId)`.

**Modified files:**
- `server/src/db/schema/reviews.ts` — extend `prIntent` table (8 new columns).
- `server/src/vendor/shared/contracts/brief.ts` — add `PrIntentDto` (a NEW wrapper schema; do NOT mutate the existing `Intent` schema).
- `client/src/vendor/shared/contracts/brief.ts` — mirror the above.
- `server/src/modules/index.ts` — register `overview` module.
- `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx` — render `<IntentCard prId={prId} />`.
- (signature change) `OverviewTab` props must include `prId: string` — the parent page already has it.
- `client/src/app/repos/[repoId]/pulls/[number]/page.tsx` — pass `prId` through to `OverviewTab`.

---

## Task 1 — Migration: extend `pr_intent` with freshness + cost columns

**Files:**
- Create: `server/src/db/migrations/0015_pr_intent_overview.sql`
- Modify: `server/src/db/schema/reviews.ts`

**Interfaces:**
- Produces (DB row, Drizzle `$inferSelect`):
  ```ts
  type PrIntentRow = {
    prId: string;
    intent: string;
    inScope: string[];
    outOfScope: string[];
    headSha: string;
    bodyHash: string;
    riskAreas: { icon: 'shield'|'package'|'zap'|'database'|'globe'; label: string }[];
    model: string | null;
    promptTokens: number;
    completionTokens: number;
    costUsd: string;       // Drizzle numeric → string by default
    computedAt: Date;
  };
  ```

- [ ] **Step 1.1 — Write the migration file**

The existing `pr_intent` table is unpopulated in code today (per spec §3 + §10), so adding `NOT NULL` columns without defaults is safe. We give freshness/numeric columns defaults so the existing zero rows (if any) would still alter cleanly.

Create `server/src/db/migrations/0015_pr_intent_overview.sql`:

```sql
ALTER TABLE "pr_intent"
  ADD COLUMN "head_sha"          text          NOT NULL DEFAULT '',
  ADD COLUMN "body_hash"         text          NOT NULL DEFAULT '',
  ADD COLUMN "risk_areas"        jsonb         NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "model"             text,
  ADD COLUMN "prompt_tokens"     integer       NOT NULL DEFAULT 0,
  ADD COLUMN "completion_tokens" integer       NOT NULL DEFAULT 0,
  ADD COLUMN "cost_usd"          numeric(10,6) NOT NULL DEFAULT 0,
  ADD COLUMN "computed_at"       timestamptz   NOT NULL DEFAULT now();
--> statement-breakpoint
-- Drop the temporary defaults on the two freshness keys: future inserts MUST
-- pass an explicit head_sha + body_hash. The defaults above only exist to
-- back-fill existing rows (there are none today; this is belt-and-braces).
ALTER TABLE "pr_intent"
  ALTER COLUMN "head_sha" DROP DEFAULT,
  ALTER COLUMN "body_hash" DROP DEFAULT;
```

- [ ] **Step 1.2 — Update the Drizzle schema**

Edit `server/src/db/schema/reviews.ts`. Replace the existing `prIntent` table definition (lines 48–55) with:

```typescript
export const prIntent = pgTable('pr_intent', {
  prId: uuid('pr_id')
    .primaryKey()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  intent: text('intent').notNull(),
  inScope: jsonb('in_scope').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  outOfScope: jsonb('out_of_scope').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  headSha: text('head_sha').notNull(),
  bodyHash: text('body_hash').notNull(),
  riskAreas: jsonb('risk_areas')
    .$type<{ icon: 'shield' | 'package' | 'zap' | 'database' | 'globe'; label: string }[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  model: text('model'),
  promptTokens: integer('prompt_tokens').notNull().default(0),
  completionTokens: integer('completion_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', { precision: 10, scale: 6 }).notNull().default('0'),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Add `numeric` to the existing `drizzle-orm/pg-core` import at line 2:

```typescript
import { pgTable, uuid, text, integer, jsonb, timestamp, doublePrecision, numeric } from 'drizzle-orm/pg-core';
```

- [ ] **Step 1.3 — Verify migration applies cleanly against a fresh container**

Run from repo root:

```bash
pnpm --dir server typecheck
pnpm --dir server exec vitest run --exclude '**/*.it.test.ts' src/db
```

Expected: typecheck passes; no schema tests fail.

Then sanity-check the SQL by booting a fresh Postgres test container (this also exercises the migration runner — `startPg` calls `runMigrations`):

```bash
pnpm --dir server exec vitest run src/modules/conventions/repository.it.test.ts
```

Expected: green. (We piggyback on an existing integration test; its `startPg()` runs **all** migrations including the new `0015_*.sql`.)

- [ ] **Step 1.4 — Commit**

```bash
git add server/src/db/migrations/0015_pr_intent_overview.sql server/src/db/schema/reviews.ts
git commit -m 'feat(overview): extend pr_intent with freshness keys + cost columns'
```

---

## Task 2 — Shared contract: `PrIntentDto`

**Files:**
- Modify: `server/src/vendor/shared/contracts/brief.ts`
- Modify: `client/src/vendor/shared/contracts/brief.ts` (byte-identical)

**Interfaces:**
- Produces:
  ```ts
  export const RiskAreaIcon = z.enum(['shield', 'package', 'zap', 'database', 'globe']);
  export type RiskAreaIcon = z.infer<typeof RiskAreaIcon>;

  export const PrIntentDto = z.object({
    goal: z.string().min(1),
    inScope: z.array(z.string()).max(20),
    outOfScope: z.array(z.string()).max(20),
    riskAreas: z.array(z.object({ icon: RiskAreaIcon, label: z.string().min(1).max(40) })).max(3),
    model: z.string(),
    cost: z.object({
      tokensIn: z.number().int().nonnegative(),
      tokensOut: z.number().int().nonnegative(),
      usd: z.number().nonnegative(),
    }),
    computedAt: z.string(),
  });
  export type PrIntentDto = z.infer<typeof PrIntentDto>;

  export const PrIntentResponse = z.discriminatedUnion('status', [
    z.object({ status: z.literal('ready'), data: PrIntentDto }),
    z.object({ status: z.literal('computing'), runId: z.string() }),
    z.object({ status: z.literal('error'), message: z.string() }),
  ]);
  export type PrIntentResponse = z.infer<typeof PrIntentResponse>;
  ```

We do **not** mutate the existing `Intent` schema (it's already shipped to the reviewer pipeline as `intent / in_scope / out_of_scope`). `PrIntentDto` is a new, wrapper-shaped DTO purely for the Overview tab.

- [ ] **Step 2.1 — Write a failing test for the contract**

Create `server/src/vendor/shared/contracts/brief.test.ts` (append if exists):

```typescript
import { describe, it, expect } from 'vitest';
import { PrIntentDto, PrIntentResponse } from './brief.js';

describe('PrIntentDto', () => {
  it('accepts a valid payload', () => {
    expect(
      PrIntentDto.safeParse({
        goal: 'Add rate-limiting to the public API.',
        inScope: ['middleware', 'route guards'],
        outOfScope: ['DB schema'],
        riskAreas: [{ icon: 'shield', label: 'auth' }],
        model: 'gpt-4o-mini',
        cost: { tokensIn: 1200, tokensOut: 300, usd: 0.0012 },
        computedAt: '2026-06-24T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown risk icons', () => {
    const res = PrIntentDto.safeParse({
      goal: 'x',
      inScope: [],
      outOfScope: [],
      riskAreas: [{ icon: 'rocket', label: 'oops' }],
      model: 'm',
      cost: { tokensIn: 0, tokensOut: 0, usd: 0 },
      computedAt: 'now',
    });
    expect(res.success).toBe(false);
  });

  it('PrIntentResponse discriminates by status', () => {
    expect(PrIntentResponse.safeParse({ status: 'computing', runId: 'r1' }).success).toBe(true);
    expect(PrIntentResponse.safeParse({ status: 'error', message: 'oops' }).success).toBe(true);
  });
});
```

Run it (expect: fails — symbols don't exist yet):

```bash
pnpm --dir server exec vitest run src/vendor/shared/contracts/brief.test.ts
```

- [ ] **Step 2.2 — Implement the schema on the server side**

Append to the bottom of `server/src/vendor/shared/contracts/brief.ts`:

```typescript
// ---- PR Overview Intent (Slice D) ----
export const RiskAreaIcon = z.enum(['shield', 'package', 'zap', 'database', 'globe']);
export type RiskAreaIcon = z.infer<typeof RiskAreaIcon>;

export const PrIntentDto = z.object({
  goal: z.string().min(1),
  inScope: z.array(z.string()).max(20),
  outOfScope: z.array(z.string()).max(20),
  riskAreas: z
    .array(z.object({ icon: RiskAreaIcon, label: z.string().min(1).max(40) }))
    .max(3),
  model: z.string(),
  cost: z.object({
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    usd: z.number().nonnegative(),
  }),
  computedAt: z.string(),
});
export type PrIntentDto = z.infer<typeof PrIntentDto>;

export const PrIntentResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), data: PrIntentDto }),
  z.object({ status: z.literal('computing'), runId: z.string() }),
  z.object({ status: z.literal('error'), message: z.string() }),
]);
export type PrIntentResponse = z.infer<typeof PrIntentResponse>;
```

- [ ] **Step 2.3 — Mirror to the client contract**

Append the **identical** block to `client/src/vendor/shared/contracts/brief.ts`. After saving, verify drift-free:

```bash
diff server/src/vendor/shared/contracts/brief.ts client/src/vendor/shared/contracts/brief.ts
```

Expected: exit code 0 (no output) **OR** only the existing differences that already exist between server/client vendor files (verify visually — the new block must be byte-identical).

- [ ] **Step 2.4 — Re-run the test (now green)**

```bash
pnpm --dir server exec vitest run src/vendor/shared/contracts/brief.test.ts
pnpm --dir server typecheck
pnpm --dir client typecheck
```

Expected: 3 tests pass; both typechecks clean.

- [ ] **Step 2.5 — Commit**

```bash
git add server/src/vendor/shared/contracts/brief.ts \
        client/src/vendor/shared/contracts/brief.ts \
        server/src/vendor/shared/contracts/brief.test.ts
git commit -m 'feat(shared): add PrIntentDto + PrIntentResponse contracts'
```

---

## Task 3 — Prompt file for the Intent extractor

**Files:**
- Create: `docs/agent-prompts/intent-extractor.md`

**Interfaces:**
- Produces: a markdown prompt loadable via `loadPromptTemplate('intent-extractor.md')` from `server/src/platform/prompts.ts`. Verify the loader resolves that directory (it does for `conventions-extract.system.md`).

- [ ] **Step 3.1 — Confirm the prompt loader's search path**

```bash
grep -n "loadPromptTemplate\|promptsDir\|agent-prompts\|prompts/" server/src/platform/prompts.ts
```

Expected: the loader resolves prompts from a known root. If the existing convention is `server/src/prompts/*.md` (like `conventions-extract.system.md`), place the file there instead and reference it from `intent/extract.ts` with the matching filename. **Use whichever path the loader already supports** — do not invent a new resolution rule. The spec's `docs/agent-prompts/...` path is aspirational; the working path lives next to other prompts.

If the loader points at `server/src/prompts/`, create `server/src/prompts/intent-extractor.system.md` instead and adjust the load call below accordingly. (Naming below assumes `server/src/prompts/intent-extractor.system.md` — change once.)

- [ ] **Step 3.2 — Write the prompt**

Create the prompt file with this content verbatim:

```markdown
# PR Intent Extractor

You restate a pull request's intent for a senior reviewer who is about to skim the
diff. You do NOT review the code; you summarise what the author is trying to do.

## Inputs you will receive
- **Title** — one line from the PR author.
- **Body** — optional markdown description (may be empty or noisy).
- **Files** — changed file paths with additions/deletions counts.

## Output
Return ONLY JSON matching the schema. No prose, no markdown, no commentary.

Fields:
- `goal` — ONE sentence (≤ 25 words) in the present tense restating what this PR
  accomplishes. Start with a verb. No marketing language. No copy-paste from the title.
- `inScope` — bullet list (3–8 items, each 3–10 words) of what IS being changed.
  Anchor each bullet to evidence in the diff (file area, behaviour). No generic
  "improves quality" filler.
- `outOfScope` — bullet list (1–5 items) of things a reviewer might WRONGLY assume
  are part of this PR. Read the title + body and pre-empt common misreadings. Use
  3–10 words each. May be empty when the title is fully explicit.
- `riskAreas` — 1–3 chips. Each chip is `{ icon, label }`. Pick `icon` ONLY from this
  closed set:
  - `shield`   — auth / authorization / secrets / crypto
  - `package`  — dependency / build / packaging / release surface
  - `zap`      — performance / latency / throughput / caching
  - `database` — schema / migration / query plan / data integrity
  - `globe`    — external API / network / public HTTP surface / SSE
  `label` is ≤ 4 words, lowercase, human (e.g. "auth middleware", "n+1 risk",
  "schema change"). Omit risk areas only when the diff is purely cosmetic.

## Rules
- Be specific. "Refactors code" is rejected.
- Never invent files or behaviours not implied by the input.
- If the body contradicts the diff, trust the diff.
- Prefer fewer bullets over padding.
- Output MUST be valid JSON.
```

- [ ] **Step 3.3 — Commit**

```bash
git add server/src/prompts/intent-extractor.system.md   # or docs/agent-prompts/... per Step 3.1
git commit -m 'feat(overview): add Intent extractor system prompt'
```

---

## Task 4 — Extractor: `extractIntent` (pure LLM call)

**Files:**
- Create: `server/src/modules/overview/intent/extract.ts`
- Create: `server/src/modules/overview/intent/extract.test.ts`

**Interfaces:**
- Consumes: `Container` (DI), `workspaceId: string`, `input: ExtractIntentInput`.
- Produces:
  ```ts
  export interface ExtractIntentInput {
    title: string;
    body: string;
    files: { path: string; additions: number; deletions: number }[];
  }
  export interface ExtractIntentResult {
    dto: PrIntentDto;     // computedAt is set by the caller (service)
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    model: string;
  }
  export function extractIntent(
    container: Container,
    workspaceId: string,
    input: ExtractIntentInput,
  ): Promise<ExtractIntentResult>;
  ```

The extractor returns the data needed to both build the DTO and write the persistence row (the service combines them with `head_sha + body_hash + computed_at`).

- [ ] **Step 4.1 — Write a failing unit test**

Create `server/src/modules/overview/intent/extract.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractIntent } from './extract.js';
import type { Container } from '../../../platform/container.js';

vi.mock('../../../platform/prompts.js', () => ({
  loadPromptTemplate: vi.fn().mockResolvedValue('You restate PR intent.'),
}));

vi.mock('../../settings/feature-models.js', () => ({
  resolveFeatureModel: vi
    .fn()
    .mockResolvedValue({ provider: 'openai', model: 'gpt-4o-mini' }),
}));

function makeContainer(fixture: unknown): Partial<Container> {
  const completeStructured = vi.fn().mockResolvedValue({
    data: fixture,
    model: 'gpt-4o-mini',
    tokensIn: 1200,
    tokensOut: 300,
    costUsd: 0.0012,
    raw: JSON.stringify(fixture),
    attempts: 1,
  });
  return {
    llm: vi.fn().mockResolvedValue({ completeStructured }),
  } as unknown as Partial<Container>;
}

describe('extractIntent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a validated DTO + cost from the structured LLM call', async () => {
    const container = makeContainer({
      goal: 'Add rate limiting to the public API.',
      inScope: ['add middleware', 'cover REST routes'],
      outOfScope: ['DB schema change'],
      riskAreas: [{ icon: 'shield', label: 'auth middleware' }],
    });

    const result = await extractIntent(container as Container, 'ws-1', {
      title: 'Rate limit public API',
      body: 'Adds a sliding-window limiter.',
      files: [{ path: 'src/api/limiter.ts', additions: 80, deletions: 0 }],
    });

    expect(result.dto.goal).toMatch(/rate limit/i);
    expect(result.dto.riskAreas).toHaveLength(1);
    expect(result.dto.riskAreas[0]!.icon).toBe('shield');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.tokensIn).toBe(1200);
    expect(result.costUsd).toBeCloseTo(0.0012, 6);
    // Sanity: the service (not the extractor) stamps computedAt.
    expect(result.dto.computedAt).toBeDefined();
  });

  it('throws when the LLM returns an invalid risk icon (Zod schema rejects)', async () => {
    const container = makeContainer({
      goal: 'x',
      inScope: [],
      outOfScope: [],
      riskAreas: [{ icon: 'rocket', label: 'no' }],
    });
    await expect(
      extractIntent(container as Container, 'ws-1', {
        title: 't',
        body: '',
        files: [],
      }),
    ).rejects.toThrow();
  });
});
```

Run (expect: fails — `extract.ts` doesn't exist):

```bash
pnpm --dir server exec vitest run src/modules/overview/intent/extract.test.ts
```

- [ ] **Step 4.2 — Implement the extractor**

Create `server/src/modules/overview/intent/extract.ts`:

```typescript
import { z } from 'zod';
import type { Container } from '../../../platform/container.js';
import type { Provider } from '@devdigest/shared';
import { loadPromptTemplate } from '../../../platform/prompts.js';
import { resolveFeatureModel } from '../../settings/feature-models.js';
import { PrIntentDto, RiskAreaIcon } from '@devdigest/shared';

export interface ExtractIntentInput {
  title: string;
  body: string;
  files: { path: string; additions: number; deletions: number }[];
}

export interface ExtractIntentResult {
  dto: PrIntentDto;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
}

/**
 * Pure LLM payload (no cost/model — those come from the LLM response wrapper).
 * The service combines this with the freshness keys + cost to produce the
 * persisted row and the wire DTO.
 */
const INTENT_PAYLOAD_SCHEMA = z.object({
  goal: z.string().min(1),
  inScope: z.array(z.string()).max(20),
  outOfScope: z.array(z.string()).max(20),
  riskAreas: z
    .array(z.object({ icon: RiskAreaIcon, label: z.string().min(1).max(40) }))
    .max(3),
});

function fileLine(f: ExtractIntentInput['files'][number]): string {
  return `- ${f.path} (+${f.additions} / -${f.deletions})`;
}

function clipBody(body: string, max = 4_000): string {
  return body.length > max ? `${body.slice(0, max)}\n…[truncated]` : body;
}

export async function extractIntent(
  container: Container,
  workspaceId: string,
  input: ExtractIntentInput,
): Promise<ExtractIntentResult> {
  const { provider, model } = await resolveFeatureModel(
    container,
    workspaceId,
    'review_intent',
  );
  const llm = await container.llm(provider as Provider);

  const systemPrompt = await loadPromptTemplate('intent-extractor.system.md');

  const fileList =
    input.files.length === 0
      ? '(no files)'
      : input.files.slice(0, 200).map(fileLine).join('\n');

  const userContent = [
    `## Title`,
    input.title,
    '',
    `## Body`,
    input.body.trim() === '' ? '(empty)' : clipBody(input.body),
    '',
    `## Files`,
    fileList,
  ].join('\n');

  const result = await llm.completeStructured({
    model,
    schema: INTENT_PAYLOAD_SCHEMA,
    schemaName: 'PrIntent',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    maxRetries: 2,
  });

  const dto: PrIntentDto = {
    goal: result.data.goal,
    inScope: result.data.inScope,
    outOfScope: result.data.outOfScope,
    riskAreas: result.data.riskAreas,
    model: result.model,
    cost: {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      usd: result.costUsd,
    },
    computedAt: new Date().toISOString(),
  };
  // Defensive: re-validate the assembled DTO so a contract drift fails fast at
  // the extractor boundary instead of leaking partial rows into the DB.
  PrIntentDto.parse(dto);

  return {
    dto,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: result.costUsd,
    model: result.model,
  };
}
```

- [ ] **Step 4.3 — Re-run the unit tests**

```bash
pnpm --dir server exec vitest run src/modules/overview/intent/extract.test.ts
pnpm --dir server typecheck
```

Expected: 2 tests pass.

- [ ] **Step 4.4 — Commit**

```bash
git add server/src/modules/overview/intent/extract.ts \
        server/src/modules/overview/intent/extract.test.ts
git commit -m 'feat(overview): add Intent LLM extractor with structured-output schema'
```

---

## Task 5 — Repository: row I/O for `pr_intent`

**Files:**
- Create: `server/src/modules/overview/intent/repository.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface IntentFreshnessKey {
    headSha: string;
    bodyHash: string;
  }
  export interface IntentRow {
    dto: PrIntentDto;
    headSha: string;
    bodyHash: string;
  }
  export class IntentRepository {
    constructor(private db: Db);
    get(prId: string): Promise<IntentRow | null>;
    upsert(
      prId: string,
      key: IntentFreshnessKey,
      result: ExtractIntentResult,
    ): Promise<void>;
  }
  ```

The repository is a thin Drizzle wrapper — no business rules here. The service decides when to call `upsert`.

- [ ] **Step 5.1 — Implement the repository**

Create `server/src/modules/overview/intent/repository.ts`:

```typescript
import { eq } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { PrIntentDto } from '@devdigest/shared';
import type { ExtractIntentResult } from './extract.js';

export interface IntentFreshnessKey {
  headSha: string;
  bodyHash: string;
}

export interface IntentRow {
  dto: PrIntentDto;
  headSha: string;
  bodyHash: string;
}

export class IntentRepository {
  constructor(private db: Db) {}

  async get(prId: string): Promise<IntentRow | null> {
    const [row] = await this.db
      .select()
      .from(t.prIntent)
      .where(eq(t.prIntent.prId, prId))
      .limit(1);
    if (!row) return null;
    // Row stored without a model is from a pre-Slice-D ghost (shouldn't exist
    // today). Treat as cache miss so the service recomputes.
    if (row.model === null) return null;
    const dto: PrIntentDto = {
      goal: row.intent,
      inScope: row.inScope,
      outOfScope: row.outOfScope,
      riskAreas: row.riskAreas,
      model: row.model,
      cost: {
        tokensIn: row.promptTokens,
        tokensOut: row.completionTokens,
        // Drizzle numeric → string. Convert at the boundary.
        usd: Number(row.costUsd),
      },
      computedAt: row.computedAt.toISOString(),
    };
    return { dto, headSha: row.headSha, bodyHash: row.bodyHash };
  }

  async upsert(
    prId: string,
    key: IntentFreshnessKey,
    result: ExtractIntentResult,
  ): Promise<void> {
    const values = {
      prId,
      intent: result.dto.goal,
      inScope: result.dto.inScope,
      outOfScope: result.dto.outOfScope,
      headSha: key.headSha,
      bodyHash: key.bodyHash,
      riskAreas: result.dto.riskAreas,
      model: result.model,
      promptTokens: result.tokensIn,
      completionTokens: result.tokensOut,
      costUsd: result.costUsd.toFixed(6),
      computedAt: new Date(),
    };
    await this.db
      .insert(t.prIntent)
      .values(values)
      .onConflictDoUpdate({
        target: t.prIntent.prId,
        set: {
          intent: values.intent,
          inScope: values.inScope,
          outOfScope: values.outOfScope,
          headSha: values.headSha,
          bodyHash: values.bodyHash,
          riskAreas: values.riskAreas,
          model: values.model,
          promptTokens: values.promptTokens,
          completionTokens: values.completionTokens,
          costUsd: values.costUsd,
          computedAt: values.computedAt,
        },
      });
  }
}
```

- [ ] **Step 5.2 — Typecheck**

```bash
pnpm --dir server typecheck
```

Expected: clean. (Repository is exercised by the service + integration tests; no standalone unit test.)

- [ ] **Step 5.3 — Commit**

```bash
git add server/src/modules/overview/intent/repository.ts
git commit -m 'feat(overview): add Intent repository (get/upsert on pr_intent)'
```

---

## Task 6 — Service: orchestrator + freshness key + SSE

**Files:**
- Create: `server/src/modules/overview/intent/service.ts`
- Create: `server/src/modules/overview/intent/service.test.ts`

**Interfaces:**
- Consumes: `Container`, `IntentRepository`, the existing `Container.runBus` + `Container.jobs`.
- Produces:
  ```ts
  export type IntentServiceResult =
    | { status: 'ready'; data: PrIntentDto }
    | { status: 'computing'; runId: string }
    | { status: 'error'; message: string };

  export class IntentService {
    constructor(container: Container, repo?: IntentRepository);
    /** Read-through: cache hit → 'ready'; miss → enqueue + 'computing'. */
    getOrCompute(workspaceId: string, prId: string): Promise<IntentServiceResult>;
    /** Force recompute regardless of freshness. */
    refresh(workspaceId: string, prId: string): Promise<{ runId: string }>;
    /** Test-only hook to drain the queue. */
    onIdle(): Promise<void>;
  }

  export function bodyHashOf(body: string | null | undefined): string; // sha256 hex
  ```

The freshness key is `(head_sha, body_hash)` where `body_hash = sha256(body ?? '')`. On miss we generate a `runId` (a UUID, used as the bus key for SSE), enqueue a `'overview.intent'` job that calls the extractor + `repo.upsert`, then publishes `done` on the bus.

- [ ] **Step 6.1 — Failing unit test for the freshness key + cold/warm/refresh paths**

Create `server/src/modules/overview/intent/service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bodyHashOf, IntentService } from './service.js';
import type { Container } from '../../../platform/container.js';

vi.mock('./extract.js', () => ({
  extractIntent: vi.fn().mockResolvedValue({
    dto: {
      goal: 'Goal.',
      inScope: ['a'],
      outOfScope: [],
      riskAreas: [],
      model: 'gpt-4o-mini',
      cost: { tokensIn: 10, tokensOut: 5, usd: 0.0001 },
      computedAt: '2026-06-24T10:00:00.000Z',
    },
    tokensIn: 10,
    tokensOut: 5,
    costUsd: 0.0001,
    model: 'gpt-4o-mini',
  }),
}));

interface FakeRepo {
  rows: Map<string, { headSha: string; bodyHash: string }>;
  get: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
}

function fakeRepo(): FakeRepo {
  const rows = new Map<string, { headSha: string; bodyHash: string }>();
  return {
    rows,
    get: vi.fn(async (prId: string) => {
      const row = rows.get(prId);
      if (!row) return null;
      return {
        dto: {
          goal: 'cached',
          inScope: [],
          outOfScope: [],
          riskAreas: [],
          model: 'm',
          cost: { tokensIn: 0, tokensOut: 0, usd: 0 },
          computedAt: '2026-06-24T10:00:00.000Z',
        },
        headSha: row.headSha,
        bodyHash: row.bodyHash,
      };
    }),
    upsert: vi.fn(async (prId: string, key: { headSha: string; bodyHash: string }) => {
      rows.set(prId, key);
    }),
  };
}

function fakeContainer(pr: { id: string; headSha: string; body: string | null }): Partial<Container> {
  const handlers = new Map<string, (payload: unknown, ctx: { jobId: string }) => Promise<void>>();
  return {
    db: {
      // The service only uses db to look up the PR row + workspace; stub it.
      // We mock the pull lookup via a tiny query-builder fake.
    } as unknown as Container['db'],
    runBus: {
      publish: vi.fn(),
      complete: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
      onDone: vi.fn(() => () => undefined),
    } as unknown as Container['runBus'],
    jobs: {
      register: vi.fn((kind: string, handler) => handlers.set(kind, handler)),
      enqueue: vi.fn(async (_ws: string, kind: string, payload: unknown) => {
        const id = `job-${kind}-${Math.random().toString(36).slice(2, 8)}`;
        const done = handlers.get(kind)!(payload, { jobId: id });
        return { id, done };
      }),
      onIdle: vi.fn(async () => undefined),
    } as unknown as Container['jobs'],
    // Service must look up the PR for head_sha + body. Tests inject a minimal
    // lookup the service goes through. See service.ts: container.reviewRepo.
    reviewRepo: {
      getPullById: vi.fn().mockResolvedValue(pr),
      // unused in this test:
    } as unknown as Container['reviewRepo'],
  };
}

describe('bodyHashOf', () => {
  it('is deterministic for empty + non-empty', () => {
    expect(bodyHashOf('')).toBe(bodyHashOf(null));
    expect(bodyHashOf('a')).not.toBe(bodyHashOf('b'));
  });
});

describe('IntentService.getOrCompute', () => {
  let pr: { id: string; headSha: string; body: string | null };
  beforeEach(() => {
    pr = { id: 'pr-1', headSha: 'sha-A', body: 'desc' };
  });

  it('cold path: returns computing + enqueues a job', async () => {
    const repo = fakeRepo();
    const container = fakeContainer(pr);
    const svc = new IntentService(container as Container, repo as never);
    const out = await svc.getOrCompute('ws-1', 'pr-1');
    expect(out.status).toBe('computing');
    await svc.onIdle();
    expect(repo.upsert).toHaveBeenCalledTimes(1);
    expect(repo.upsert.mock.calls[0]![1]).toMatchObject({ headSha: 'sha-A' });
  });

  it('warm path: freshness key matches → ready', async () => {
    const repo = fakeRepo();
    repo.rows.set('pr-1', { headSha: 'sha-A', bodyHash: bodyHashOf('desc') });
    const container = fakeContainer(pr);
    const svc = new IntentService(container as Container, repo as never);
    const out = await svc.getOrCompute('ws-1', 'pr-1');
    expect(out.status).toBe('ready');
  });

  it('drift path: head_sha changed → recompute', async () => {
    const repo = fakeRepo();
    repo.rows.set('pr-1', { headSha: 'sha-OLD', bodyHash: bodyHashOf('desc') });
    const container = fakeContainer(pr);
    const svc = new IntentService(container as Container, repo as never);
    const out = await svc.getOrCompute('ws-1', 'pr-1');
    expect(out.status).toBe('computing');
    await svc.onIdle();
    expect(repo.upsert.mock.calls[0]![1]).toMatchObject({ headSha: 'sha-A' });
  });
});
```

Run (expect: fails — module not yet present):

```bash
pnpm --dir server exec vitest run src/modules/overview/intent/service.test.ts
```

- [ ] **Step 6.2 — Implement the service**

Create `server/src/modules/overview/intent/service.ts`:

```typescript
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Container } from '../../../platform/container.js';
import * as t from '../../../db/schema.js';
import type { PrIntentDto } from '@devdigest/shared';
import { extractIntent } from './extract.js';
import { IntentRepository } from './repository.js';
import { NotFoundError } from '../../../platform/errors.js';

const JOB_KIND = 'overview.intent';

export type IntentServiceResult =
  | { status: 'ready'; data: PrIntentDto }
  | { status: 'computing'; runId: string }
  | { status: 'error'; message: string };

export function bodyHashOf(body: string | null | undefined): string {
  return createHash('sha256').update(body ?? '').digest('hex');
}

interface JobPayload {
  workspaceId: string;
  prId: string;
  runId: string;
}

export class IntentService {
  private repo: IntentRepository;
  private registered = false;

  constructor(private container: Container, repo?: IntentRepository) {
    this.repo = repo ?? new IntentRepository(container.db);
    this.ensureHandler();
  }

  /** Idempotent: registers the job handler once per container/service pair. */
  private ensureHandler(): void {
    if (this.registered) return;
    this.registered = true;
    this.container.jobs.register(JOB_KIND, async (raw) => {
      const payload = raw as JobPayload;
      const bus = this.container.runBus;
      try {
        bus.publish(payload.runId, 'info', 'Extracting PR intent…');
        const pr = await this.loadPr(payload.prId);
        if (!pr) {
          bus.publish(payload.runId, 'error', 'PR not found');
          bus.complete(payload.runId);
          return;
        }
        const files = await this.loadFiles(payload.prId);
        const result = await extractIntent(this.container, payload.workspaceId, {
          title: pr.title,
          body: pr.body ?? '',
          files: files.map((f) => ({
            path: f.path,
            additions: f.additions,
            deletions: f.deletions,
          })),
        });
        await this.repo.upsert(
          payload.prId,
          { headSha: pr.headSha, bodyHash: bodyHashOf(pr.body) },
          result,
        );
        bus.publish(payload.runId, 'done', 'Intent ready', {
          model: result.model,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
        });
      } catch (err) {
        bus.publish(payload.runId, 'error', (err as Error).message);
      } finally {
        bus.complete(payload.runId);
      }
    });
  }

  async getOrCompute(workspaceId: string, prId: string): Promise<IntentServiceResult> {
    const pr = await this.loadPr(prId);
    if (!pr) throw new NotFoundError('PR not found');
    const wantedKey = { headSha: pr.headSha, bodyHash: bodyHashOf(pr.body) };
    const row = await this.repo.get(prId);
    if (row && row.headSha === wantedKey.headSha && row.bodyHash === wantedKey.bodyHash) {
      return { status: 'ready', data: row.dto };
    }
    const runId = randomUUID();
    await this.container.jobs.enqueue(workspaceId, JOB_KIND, {
      workspaceId,
      prId,
      runId,
    } satisfies JobPayload);
    return { status: 'computing', runId };
  }

  async refresh(workspaceId: string, prId: string): Promise<{ runId: string }> {
    const pr = await this.loadPr(prId);
    if (!pr) throw new NotFoundError('PR not found');
    const runId = randomUUID();
    await this.container.jobs.enqueue(workspaceId, JOB_KIND, {
      workspaceId,
      prId,
      runId,
    } satisfies JobPayload);
    return { runId };
  }

  async onIdle(): Promise<void> {
    await this.container.jobs.onIdle();
  }

  private async loadPr(prId: string): Promise<{
    id: string;
    title: string;
    body: string | null;
    headSha: string;
  } | null> {
    const [row] = await this.container.db
      .select({
        id: t.pullRequests.id,
        title: t.pullRequests.title,
        body: t.pullRequests.body,
        headSha: t.pullRequests.headSha,
      })
      .from(t.pullRequests)
      .where(eq(t.pullRequests.id, prId))
      .limit(1);
    return row ?? null;
  }

  private async loadFiles(prId: string): Promise<{
    path: string;
    additions: number;
    deletions: number;
  }[]> {
    return this.container.db
      .select({
        path: t.prFiles.path,
        additions: t.prFiles.additions,
        deletions: t.prFiles.deletions,
      })
      .from(t.prFiles)
      .where(eq(t.prFiles.prId, prId));
  }
}
```

> Note for Step 6.1: the test's fake container shortcuts the PR lookup by injecting it; the production code goes through `t.pullRequests` directly. Adjust the test to mock `container.db` with a minimal query-builder fake if the strict-typed `Db` is awkward — preferable: add a thin `loadPr` override hook on the service for testing, OR use `startPg()` and turn `service.test.ts` into `service.it.test.ts`. **Pick one before writing the test in 6.1.** Easiest path: rename to `service.it.test.ts`, seed `pull_requests` + `pr_files`, and let the real DB drive freshness.

If you take the `.it.test.ts` route, also gate on `dockerAvailable()` per the existing pattern in `conventions/repository.it.test.ts`.

- [ ] **Step 6.3 — Re-run the test**

```bash
pnpm --dir server exec vitest run src/modules/overview/intent/
pnpm --dir server typecheck
```

Expected: 3 service tests pass + the 2 extractor tests still pass; typecheck clean.

- [ ] **Step 6.4 — Commit**

```bash
git add server/src/modules/overview/intent/service.ts \
        server/src/modules/overview/intent/service.test.ts
git commit -m 'feat(overview): add Intent service (freshness key + job + SSE)'
```

---

## Task 7 — Routes + module registration + integration test

**Files:**
- Create: `server/src/modules/overview/routes.ts`
- Create: `server/src/modules/overview/routes.it.test.ts`
- Modify: `server/src/modules/index.ts`

**Interfaces:**
- HTTP surface:
  - `GET  /api/pulls/:prId/overview/intent` → `PrIntentResponse`
  - `GET  /api/pulls/:prId/overview/intent/stream` → SSE (event kinds: `info | done | error`)
  - `POST /api/pulls/:prId/overview/intent/refresh` → `{ runId: string }`
- Auth: same workspace-scoped `getContext` pattern used by `conventions/routes.ts`.

- [ ] **Step 7.1 — Failing integration test (skeleton)**

Create `server/src/modules/overview/routes.it.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { startPg, dockerAvailable, type PgFixture } from '../../../test/helpers/pg.js';
import { seed } from '../../db/seed.js';
import * as t from '../../db/schema.js';
import { Container } from '../../platform/container.js';
import { MockLLMProvider } from '../../adapters/mocks.js';
import overview from './routes.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;
if (!hasDocker) console.warn('[overview] Docker unavailable — skipping integration tests.');

d('overview/intent routes', () => {
  let pg: PgFixture;
  let app: FastifyInstance;
  let workspaceId: string;
  let prId: string;
  let llm: MockLLMProvider;

  beforeAll(async () => {
    pg = await startPg();
  });
  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    if (app) await app.close();
    const { db } = pg.handle;
    await db.delete(t.prIntent);
    const seeded = await seed(db);
    workspaceId = seeded.workspaceId;

    const [repo] = await db
      .insert(t.repos)
      .values({ workspaceId, owner: 't', name: `r-${Date.now()}`, fullName: 't/r' })
      .returning();
    const [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 1,
        title: 'Rate limit public API',
        author: 'a',
        branch: 'feat',
        base: 'main',
        headSha: 'sha-A',
        body: 'Adds a sliding-window limiter.',
      })
      .returning();
    prId = pr!.id;
    await db.insert(t.prFiles).values({
      prId,
      path: 'src/api/limiter.ts',
      additions: 80,
      deletions: 0,
    });

    llm = new MockLLMProvider('openai', {
      structuredBySchema: {
        PrIntent: {
          goal: 'Add rate limiting to the public API.',
          inScope: ['add middleware'],
          outOfScope: [],
          riskAreas: [{ icon: 'shield', label: 'auth middleware' }],
        },
      },
    });

    app = Fastify();
    await app.register(sensible);
    // Test app uses the test workspace as the implicit context; mirror the
    // shape conventions/routes.it.test.ts uses (see decorateRequest there).
    const container = new Container(
      { secretsPath: '/tmp', cloneDir: '/tmp', embeddingsEnabled: false } as never,
      pg.handle.db,
      { llm: { openai: llm } },
    );
    app.decorate('container', container);
    await app.register(overview, { prefix: '/api' });
    await app.ready();
  });

  it('GET /overview/intent → computing on first call, ready after job drains', async () => {
    const cold = await app.inject({ method: 'GET', url: `/api/pulls/${prId}/overview/intent` });
    expect(cold.statusCode).toBe(200);
    expect(cold.json().status).toBe('computing');

    // Drain the in-memory job queue.
    await app.container.jobs.onIdle();

    const warm = await app.inject({ method: 'GET', url: `/api/pulls/${prId}/overview/intent` });
    expect(warm.statusCode).toBe(200);
    const body = warm.json();
    expect(body.status).toBe('ready');
    expect(body.data.goal).toMatch(/rate limit/i);
    expect(body.data.riskAreas[0].icon).toBe('shield');
  });

  it('POST /overview/intent/refresh recomputes even when freshness matches', async () => {
    // Prime cache.
    await app.inject({ method: 'GET', url: `/api/pulls/${prId}/overview/intent` });
    await app.container.jobs.onIdle();
    const callsBefore = llm.calls.filter((c) => c.method === 'completeStructured').length;

    const r = await app.inject({
      method: 'POST',
      url: `/api/pulls/${prId}/overview/intent/refresh`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().runId).toBeTruthy();
    await app.container.jobs.onIdle();
    const callsAfter = llm.calls.filter((c) => c.method === 'completeStructured').length;
    expect(callsAfter).toBe(callsBefore + 1);
  });

  it('GET /overview/intent recomputes when head_sha drifts', async () => {
    await app.inject({ method: 'GET', url: `/api/pulls/${prId}/overview/intent` });
    await app.container.jobs.onIdle();
    await pg.handle.db
      .update(t.pullRequests)
      .set({ headSha: 'sha-B' })
      .where((row) => row); // noop predicate — replace with eq(t.pullRequests.id, prId) in the real test
    const r = await app.inject({ method: 'GET', url: `/api/pulls/${prId}/overview/intent` });
    expect(r.json().status).toBe('computing');
  });
});
```

> Adjust the `.where(...)` predicate to `eq(t.pullRequests.id, prId)` — the snippet above shows the structure; Drizzle's typed `where` rejects the `(row) => row` lambda placeholder.

Run (expect: fails — `routes.ts` missing):

```bash
pnpm --dir server exec vitest run src/modules/overview/routes.it.test.ts
```

- [ ] **Step 7.2 — Implement the routes**

Create `server/src/modules/overview/routes.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getContext } from '../_shared/context.js';
import { IntentService } from './intent/service.js';

const PrParams = z.object({ prId: z.string().uuid() });

/**
 * Overview module routes (Slice D — Intent only; Brief / Blast Radius / Prior
 * PRs are added in Slices A–C and will share this plugin).
 *
 *   GET  /api/pulls/:prId/overview/intent
 *   GET  /api/pulls/:prId/overview/intent/stream     (SSE)
 *   POST /api/pulls/:prId/overview/intent/refresh
 */
export default async function overviewRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const intent = new IntentService(app.container);

  app.get(
    '/pulls/:prId/overview/intent',
    { schema: { params: PrParams } },
    async (req) => {
      const { workspaceId } = await getContext(app.container, req);
      return intent.getOrCompute(workspaceId, req.params.prId);
    },
  );

  app.post(
    '/pulls/:prId/overview/intent/refresh',
    { schema: { params: PrParams } },
    async (req, reply) => {
      const { workspaceId } = await getContext(app.container, req);
      const out = await intent.refresh(workspaceId, req.params.prId);
      reply.status(202);
      return out;
    },
  );

  app.get(
    '/pulls/:prId/overview/intent/stream',
    { schema: { params: PrParams, querystring: z.object({ runId: z.string() }) }, config: { rateLimit: false } },
    async (req, reply) => {
      const { workspaceId: _ws } = await getContext(app.container, req);
      const { runId } = req.query;
      reply.sse(
        (async function* () {
          const queue: { seq: number; kind: string }[] = [];
          let resolve: (() => void) | null = null;
          let done = false;
          const unsubscribe = app.container.runBus.subscribe(runId, (e) => {
            queue.push(e);
            resolve?.();
          });
          const offDone = app.container.runBus.onDone(runId, () => {
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
              const e = queue.shift()!;
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
}
```

- [ ] **Step 7.3 — Register the module**

Edit `server/src/modules/index.ts`. Add an import and a registry entry:

```typescript
import overview from './overview/routes.js';
// …
export const modules: Record<string, FastifyPluginAsync> = {
  // … existing entries …
  overview,
};
```

- [ ] **Step 7.4 — Run tests + typecheck**

```bash
pnpm --dir server typecheck
pnpm --dir server exec vitest run src/modules/overview/
```

Expected: all overview unit + integration tests green. If the integration test skipped (no Docker), at least the unit suites pass.

- [ ] **Step 7.5 — Commit**

```bash
git add server/src/modules/overview/routes.ts \
        server/src/modules/overview/routes.it.test.ts \
        server/src/modules/index.ts
git commit -m 'feat(overview): register overview module + Intent HTTP routes + SSE'
```

---

## Task 8 — Client hook: `useOverviewIntent`

**Files:**
- Create: `client/src/lib/hooks/overview.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface UseOverviewIntent {
    status: 'idle' | 'loading' | 'ready' | 'computing' | 'error';
    data: PrIntentDto | null;
    error: string | null;
    progress: string | null;          // last SSE message while computing
    refresh: () => Promise<void>;
  }
  export function useOverviewIntent(prId: string | null): UseOverviewIntent;
  ```

- [ ] **Step 8.1 — Implement the hook**

Create `client/src/lib/hooks/overview.ts`:

```typescript
'use client';

import React from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { PrIntentDto, PrIntentResponse } from '@devdigest/shared';
import { apiFetch, API_BASE } from '../api.js';

const keyIntent = (prId: string) => ['overview', 'intent', prId] as const;

export interface UseOverviewIntent {
  status: 'idle' | 'loading' | 'ready' | 'computing' | 'error';
  data: PrIntentDto | null;
  error: string | null;
  progress: string | null;
  refresh: () => Promise<void>;
}

export function useOverviewIntent(prId: string | null): UseOverviewIntent {
  const qc = useQueryClient();
  const [progress, setProgress] = React.useState<string | null>(null);

  const query = useQuery({
    queryKey: prId ? keyIntent(prId) : ['overview', 'intent', '__none__'],
    queryFn: () => apiFetch<PrIntentResponse>(`/api/pulls/${prId}/overview/intent`),
    enabled: prId !== null,
  });

  // While the server says 'computing', subscribe to the SSE stream and
  // invalidate the query on `done` so the next fetch returns 'ready'.
  React.useEffect(() => {
    if (!prId || query.data?.status !== 'computing') {
      setProgress(null);
      return;
    }
    const runId = query.data.runId;
    setProgress('Starting…');
    const es = new EventSource(
      `${API_BASE}/api/pulls/${prId}/overview/intent/stream?runId=${encodeURIComponent(runId)}`,
    );
    const onMsg = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { msg?: string; kind?: string };
        if (data.msg) setProgress(data.msg);
      } catch {
        /* keepalive */
      }
    };
    es.addEventListener('info', onMsg as EventListener);
    es.addEventListener('done', () => {
      es.close();
      qc.invalidateQueries({ queryKey: keyIntent(prId) });
    });
    es.addEventListener('error', (ev: Event) => {
      es.close();
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { msg?: string };
        setProgress(data.msg ?? 'Failed');
      } catch {
        /* native error event has no data */
      }
      qc.invalidateQueries({ queryKey: keyIntent(prId) });
    });
    return () => {
      es.close();
    };
  }, [prId, query.data, qc]);

  const refreshMut = useMutation({
    mutationFn: () =>
      apiFetch<{ runId: string }>(`/api/pulls/${prId}/overview/intent/refresh`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keyIntent(prId ?? '') }),
  });

  let status: UseOverviewIntent['status'] = 'idle';
  let data: PrIntentDto | null = null;
  let error: string | null = null;
  if (!prId) status = 'idle';
  else if (query.isLoading) status = 'loading';
  else if (query.error) {
    status = 'error';
    error = (query.error as Error).message;
  } else if (query.data?.status === 'ready') {
    status = 'ready';
    data = query.data.data;
  } else if (query.data?.status === 'computing') {
    status = 'computing';
  } else if (query.data?.status === 'error') {
    status = 'error';
    error = query.data.message;
  }

  return {
    status,
    data,
    error,
    progress,
    refresh: async () => {
      await refreshMut.mutateAsync();
    },
  };
}
```

- [ ] **Step 8.2 — Typecheck**

```bash
pnpm --dir client typecheck
```

Expected: clean.

- [ ] **Step 8.3 — Commit**

```bash
git add client/src/lib/hooks/overview.ts
git commit -m 'feat(overview): add useOverviewIntent hook (status/SSE/refresh)'
```

---

## Task 9 — `IntentCard` component + wire into `OverviewTab`

**Files:**
- Create: `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/IntentCard.tsx`
- Create: `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/index.ts`
- Create: `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/IntentCard.test.tsx`
- Modify: `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx`
- Modify: `client/src/app/repos/[repoId]/pulls/[number]/page.tsx`

**Interfaces:**
- Component: `<IntentCard prId={string} />`.
- States: `loading` (skeleton), `computing` (skeleton + progress line), `ready` (goal + 2-col scope + chips + footer), `error` (inline error + Refresh).

- [ ] **Step 9.1 — Failing RTL test**

Create `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/IntentCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntentCard } from './IntentCard';
import * as overviewHooks from '../../../../../../../../lib/hooks/overview';

vi.mock('../../../../../../../../lib/hooks/overview');

const READY_DTO = {
  goal: 'Add rate limiting to the public API.',
  inScope: ['Add sliding-window middleware', 'Cover all /api/* routes'],
  outOfScope: ['Changes to the DB schema'],
  riskAreas: [{ icon: 'shield' as const, label: 'auth middleware' }],
  model: 'gpt-4o-mini',
  cost: { tokensIn: 1200, tokensOut: 300, usd: 0.0012 },
  computedAt: new Date().toISOString(),
};

describe('IntentCard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders ready state: goal + scope bullets + risk chip', () => {
    vi.mocked(overviewHooks.useOverviewIntent).mockReturnValue({
      status: 'ready',
      data: READY_DTO,
      error: null,
      progress: null,
      refresh: vi.fn(),
    });
    render(<IntentCard prId="pr-1" />);
    expect(screen.getByText(/rate limiting/i)).toBeInTheDocument();
    expect(screen.getByText(/sliding-window middleware/i)).toBeInTheDocument();
    expect(screen.getByText(/DB schema/i)).toBeInTheDocument();
    expect(screen.getByText(/auth middleware/i)).toBeInTheDocument();
  });

  it('renders computing state: progress line + skeleton (no scope content)', () => {
    vi.mocked(overviewHooks.useOverviewIntent).mockReturnValue({
      status: 'computing',
      data: null,
      error: null,
      progress: 'Extracting PR intent…',
      refresh: vi.fn(),
    });
    render(<IntentCard prId="pr-1" />);
    expect(screen.getByText(/extracting PR intent/i)).toBeInTheDocument();
    expect(screen.queryByText(/auth middleware/i)).not.toBeInTheDocument();
  });

  it('renders error state with a Refresh button', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    vi.mocked(overviewHooks.useOverviewIntent).mockReturnValue({
      status: 'error',
      data: null,
      error: 'boom',
      progress: null,
      refresh,
    });
    render(<IntentCard prId="pr-1" />);
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('Refresh button triggers refresh() in ready state', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    vi.mocked(overviewHooks.useOverviewIntent).mockReturnValue({
      status: 'ready',
      data: READY_DTO,
      error: null,
      progress: null,
      refresh,
    });
    render(<IntentCard prId="pr-1" />);
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
```

Run (expect: fails — component missing):

```bash
pnpm --dir client exec vitest run src/app/repos/\[repoId\]/pulls/\[number\]/_components/OverviewTab/_components/IntentCard/IntentCard.test.tsx
```

- [ ] **Step 9.2 — Implement `IntentCard`**

Create `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/IntentCard.tsx`:

```tsx
'use client';

import React from 'react';
import { Shield, Package, Zap, Database, Globe } from 'lucide-react';
import { Button, SectionLabel } from '@devdigest/ui';
import type { RiskAreaIcon } from '@devdigest/shared';
import { useOverviewIntent } from '../../../../../../../../lib/hooks/overview';

const ICON_MAP: Record<RiskAreaIcon, React.ComponentType<{ size?: number }>> = {
  shield: Shield,
  package: Package,
  zap: Zap,
  database: Database,
  globe: Globe,
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

interface IntentCardProps {
  prId: string;
}

export function IntentCard({ prId }: IntentCardProps) {
  const { status, data, error, progress, refresh } = useOverviewIntent(prId);

  return (
    <section aria-label="PR Intent" style={cardStyle}>
      <header style={headerStyle}>
        <SectionLabel icon="Target">Intent</SectionLabel>
        <Button size="sm" variant="ghost" onClick={() => refresh()}>
          Refresh
        </Button>
      </header>

      {status === 'loading' && <p style={mutedStyle}>Loading…</p>}

      {status === 'computing' && (
        <div>
          <p style={mutedStyle}>{progress ?? 'Computing…'}</p>
          <div style={skeletonStyle} aria-hidden />
        </div>
      )}

      {status === 'error' && (
        <p role="alert" style={errorStyle}>
          {error ?? 'Failed to load intent.'}
        </p>
      )}

      {status === 'ready' && data && (
        <>
          <p style={goalStyle}>{data.goal}</p>

          <div style={twoColStyle}>
            <div>
              <h4 style={subHeadStyle}>In scope</h4>
              <ul style={listStyle}>
                {data.inScope.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4 style={subHeadStyle}>Out of scope</h4>
              <ul style={listStyle}>
                {data.outOfScope.length === 0 ? (
                  <li style={mutedStyle}>— none —</li>
                ) : (
                  data.outOfScope.map((s, i) => <li key={i}>{s}</li>)
                )}
              </ul>
            </div>
          </div>

          {data.riskAreas.length > 0 && (
            <div style={chipsRowStyle}>
              {data.riskAreas.map((r, i) => {
                const Icon = ICON_MAP[r.icon];
                return (
                  <span key={i} style={chipStyle}>
                    <Icon size={14} />
                    <span>{r.label}</span>
                  </span>
                );
              })}
            </div>
          )}

          <footer style={footerStyle}>
            Computed {timeAgo(data.computedAt)} · ${data.cost.usd.toFixed(4)} ·{' '}
            {data.model}
          </footer>
        </>
      )}
    </section>
  );
}

// Inline styles — keep this card self-contained; if the broader OverviewTab
// adopts a styles.ts, move them there in a follow-up.
const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 8,
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};
const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};
const goalStyle: React.CSSProperties = { fontSize: 16, fontWeight: 500, margin: 0 };
const twoColStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 16,
};
const subHeadStyle: React.CSSProperties = {
  fontSize: 12,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  margin: '0 0 4px',
  color: 'var(--muted, #888)',
};
const listStyle: React.CSSProperties = { margin: 0, paddingLeft: 18 };
const chipsRowStyle: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' };
const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 12,
  background: 'var(--chip-bg, #1a1a1a)',
  fontSize: 12,
};
const footerStyle: React.CSSProperties = { fontSize: 11, color: 'var(--muted, #888)' };
const mutedStyle: React.CSSProperties = { color: 'var(--muted, #888)', margin: 0 };
const errorStyle: React.CSSProperties = { color: 'var(--danger, #e36)', margin: 0 };
const skeletonStyle: React.CSSProperties = {
  height: 64,
  borderRadius: 4,
  background:
    'linear-gradient(90deg, var(--skel-1,#222), var(--skel-2,#2a2a2a), var(--skel-1,#222))',
  marginTop: 8,
};
```

Create the barrel `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/_components/IntentCard/index.ts`:

```typescript
export { IntentCard } from './IntentCard';
```

- [ ] **Step 9.3 — Wire into `OverviewTab` + page**

Edit `client/src/app/repos/[repoId]/pulls/[number]/_components/OverviewTab/OverviewTab.tsx`:

```tsx
'use client';

import React from 'react';
import { SectionLabel } from '@devdigest/ui';
import { IntentCard } from './_components/IntentCard';
import { s } from './styles';

interface OverviewTabProps {
  prId: string;
  prBody: string | null | undefined;
}

export function OverviewTab({ prId, prBody }: OverviewTabProps) {
  return (
    <>
      <IntentCard prId={prId} />
      {prBody && (
        <section>
          <SectionLabel icon="MessageSquare">Description</SectionLabel>
          <div style={s.descriptionBox}>{prBody}</div>
        </section>
      )}
    </>
  );
}
```

Then update the call site in `client/src/app/repos/[repoId]/pulls/[number]/page.tsx` — pass `prId` alongside `prBody`. (The PR detail page already has the PR id; locate the existing `<OverviewTab prBody={…} />` usage and add `prId={pr.id}`.)

- [ ] **Step 9.4 — Run all tests + typecheck**

```bash
pnpm --dir client typecheck
pnpm --dir client exec vitest run src/app/repos
```

Expected: 4 IntentCard tests pass; no regressions in the rest of the PR detail tab.

If lucide icon imports differ in this project's bundle, swap `Shield/Package/Zap/Database/Globe` for the equivalent symbols from `@devdigest/ui`'s `Icon` set (used in existing `OverviewTab.tsx`).

- [ ] **Step 9.5 — Commit**

```bash
git add client/src/app/repos/\[repoId\]/pulls/\[number\]/_components/OverviewTab/ \
        client/src/app/repos/\[repoId\]/pulls/\[number\]/page.tsx
git commit -m 'feat(overview): render IntentCard in OverviewTab + RTL coverage'
```

---

## Task 10 — End-to-end smoke + final verification

**Files:**
- (No new files.) Final verification pass over the slice.

- [ ] **Step 10.1 — Run full unit + integration suites on the server**

```bash
pnpm --dir server typecheck
pnpm --dir server exec vitest run --exclude '**/*.it.test.ts'
pnpm --dir server exec vitest run .it.test
```

Expected: all green. If integration suites skip because Docker isn't running, start it and re-run — Slice D MUST be verified against a real DB before claiming ready.

- [ ] **Step 10.2 — Run full unit suite on the client**

```bash
pnpm --dir client typecheck
pnpm --dir client exec vitest run
```

Expected: all green.

- [ ] **Step 10.3 — Run the pre-ready architectural check**

Per root `CLAUDE.md`:

```
/pr-self-review
```

Address any `MUST` findings before claiming the slice ready. `SHOULD` findings go into the PR summary as advisory.

- [ ] **Step 10.4 — Engineering-insights pass**

Per global rules: if anything non-obvious surfaced (Drizzle `numeric` ↔ string coercion gotcha, the head_sha-default-then-drop migration pattern, the `loadPromptTemplate` resolution path, SSE-stream + `runId` query-param contract), record it via `/engineering-insights` against the touched modules' `LEARNINGS.md`.

---

## Self-review checklist

Before claiming Slice D ready, confirm each item below by inspection (no skipping).

- [ ] Migration `0015_pr_intent_overview.sql` is append-only — no prior migration was modified.
- [ ] Drizzle schema in `server/src/db/schema/reviews.ts` matches the migration columns exactly (types, nullability, defaults).
- [ ] `PrIntentDto` is added — the existing `Intent` schema in `brief.ts` is **untouched** (no breaking change to reviewer-core).
- [ ] `server/src/vendor/shared/contracts/brief.ts` and `client/src/vendor/shared/contracts/brief.ts` are byte-identical for the new block.
- [ ] LLM provider is resolved per-request via `resolveFeatureModel(container, workspaceId, 'review_intent')`. No hardcoded provider/model strings in the extractor.
- [ ] No `throw new Error(...)` in route handlers — only `NotFoundError` / other `platform/errors.ts` types.
- [ ] SSE goes through `reply.sse(...)` + `container.runBus`. No `reply.raw` writes.
- [ ] `pr_intent` is only written by `IntentService.upsert` callers (single-writer invariant).
- [ ] Freshness key: `(head_sha, body_hash)` where `body_hash = sha256(body ?? '')`. Cold miss enqueues; warm hit returns 'ready' synchronously.
- [ ] `MockLLMProvider` is used in tests only; never imported from production modules.
- [ ] Integration test seeds workspace + repo + PR + pr_files; asserts cold→warm→drift→refresh; gated on `dockerAvailable()`.
- [ ] Client hook subscribes to SSE only while status is `computing` and unsubscribes on cleanup; invalidates the query on `done`.
- [ ] `IntentCard` renders all 4 states (loading / computing / ready / error) and a `Refresh` button in every visible state.
- [ ] `OverviewTab` receives `prId` as a prop and passes it to `IntentCard`. The PR detail page passes the PR id through.
- [ ] Commits are small, logical, and scoped per task; commit messages explain why where it's non-obvious.
- [ ] `/pr-self-review` reports zero unaddressed `MUST` findings.

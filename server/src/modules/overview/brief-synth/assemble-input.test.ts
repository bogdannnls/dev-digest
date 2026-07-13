import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as t from '../../../db/schema.js';
import type { Db } from '../../../db/client.js';
import type { Container } from '../../../platform/container.js';
import type { BlastResult } from '../../repo-intel/types.js';
import { assembleBriefInput, RATIONALE_CLIP_CHARS } from './assemble-input.js';
import { computeFindingsByPr } from '../../pulls/routes.js';

const PR_ID = 'pr-1';
const WS_ID = 'ws-1';
const REPO_ID = 'repo-1';

const BLAST_RESULT: BlastResult = {
  changedSymbols: [{ file: 'src/auth.ts', name: 'login', kind: 'function' }],
  callers: [],
  impactedEndpoints: [],
  degraded: true,
  reason: 'no_data',
};

type Row = Record<string, unknown>;

interface Fixtures {
  pullRequests?: Row[];
  reviews?: Row[];
  prIntent?: Row[];
  prFiles?: Row[];
  findings?: Row[];
  /** Canned result for `computeFindingsByPr`'s grouped COUNT query. */
  findingsCountRows?: Row[];
  /** Canned result for `computeFindingsByPr`'s raw `db.execute(sql\`\`)` title query. */
  titleRows?: Row[];
}

/**
 * Minimal fake `db` covering every chain shape `assembleBriefInput` and
 * `computeFindingsByPr` use: `select(cols).from(table).where(cond)`, plus
 * `.innerJoin()`/`.groupBy()`/`.orderBy()` as inert passthroughs (each test
 * seeds fixtures already shaped as if the ignored `where`/`orderBy` clauses
 * had already run — same pattern as `overview/intent/service.test.ts`'s
 * `makeDb`). `db.execute(sql\`\`)` resolves to a plain array directly (see
 * server/INSIGHTS.md 2026-06-19 — no `.rows` wrapper with this driver).
 */
class FakeQuery implements PromiseLike<Row[]> {
  private groupByCalled = false;
  constructor(
    private table: unknown,
    private fixtures: Fixtures,
  ) {}

  from(table: unknown): this {
    this.table = table;
    return this;
  }
  innerJoin(): this {
    return this;
  }
  where(): this {
    return this;
  }
  orderBy(): this {
    return this;
  }
  groupBy(): this {
    this.groupByCalled = true;
    return this;
  }
  limit(): this {
    return this;
  }

  then<TResult1 = Row[], TResult2 = never>(
    onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.resolveRows()).then(onfulfilled, onrejected);
  }

  private resolveRows(): Row[] {
    const f = this.fixtures;
    if (this.table === t.pullRequests) return f.pullRequests ?? [];
    if (this.table === t.reviews) return f.reviews ?? [];
    if (this.table === t.prIntent) return f.prIntent ?? [];
    if (this.table === t.prFiles) return f.prFiles ?? [];
    if (this.table === t.findings) return this.groupByCalled ? (f.findingsCountRows ?? []) : (f.findings ?? []);
    return [];
  }
}

function makeFakeDb(fixtures: Fixtures) {
  return {
    select: () => ({ from: (table: unknown) => new FakeQuery(table, fixtures) }),
    execute: async () => fixtures.titleRows ?? [],
  };
}

function makeContainer(
  fixtures: Fixtures,
  overrides: {
    agentsRepo?: { getById: ReturnType<typeof vi.fn>; linkedSkills: ReturnType<typeof vi.fn> };
    context?: { listPaths: ReturnType<typeof vi.fn> };
    repoIntel?: { getBlastRadius: ReturnType<typeof vi.fn> };
  } = {},
): Container {
  return {
    db: makeFakeDb(fixtures),
    repoIntel: overrides.repoIntel ?? { getBlastRadius: vi.fn().mockResolvedValue(BLAST_RESULT) },
    agentsRepo: overrides.agentsRepo ?? {
      getById: vi.fn().mockResolvedValue(undefined),
      linkedSkills: vi.fn().mockResolvedValue([]),
    },
    context: overrides.context ?? { listPaths: vi.fn().mockResolvedValue(new Set<string>()) },
  } as unknown as Container;
}

const PR_ROW: Row = { id: PR_ID, workspaceId: WS_ID, repoId: REPO_ID, headSha: 'sha-abc' };

const INTENT_ROW: Row = {
  prId: PR_ID,
  intent: 'Add rate limiting to the API',
  inScope: ['add middleware'],
  outOfScope: ['redis backend'],
  headSha: 'sha-abc',
  bodyHash: 'hash-1',
  references: [
    {
      kind: 'github_issue',
      id: '#12',
      status: 'ok',
      bodyHash: 'deadbeef',
      bodyChars: 40,
      fetchedAt: '2026-07-01T00:00:00.000Z',
      error: null,
    },
  ],
  riskAreas: [{ icon: 'shield', label: 'auth middleware' }],
  model: 'claude-haiku-4-5-20251001',
  promptTokens: 100,
  completionTokens: 50,
  costUsd: '0.0009',
  computedAt: new Date('2026-07-01T00:00:00.000Z'),
};

// Pre-sorted desc by createdAt — the fake's `.orderBy()` is a no-op, so the
// fixture order stands in for what a real `ORDER BY created_at DESC` returns.
const REVIEW_LATEST: Row = { id: 'review-latest', prId: PR_ID, agentId: null };
const REVIEW_OLD: Row = { id: 'review-old', prId: PR_ID, agentId: null };

const PR_FILES: Row[] = [
  { path: 'src/auth.ts', additions: 10, deletions: 2 },
  { path: 'src/util.ts', additions: 5, deletions: 1 },
];

const OVERSIZED_RATIONALE = 'A'.repeat(600);

const FINDINGS: Row[] = [
  // Belongs to the OLDER review — must never appear in the assembled set.
  {
    id: 'f-old-1',
    reviewId: 'review-old',
    file: 'old.ts',
    startLine: 1,
    endLine: 2,
    severity: 'CRITICAL',
    category: 'security',
    title: 'Old finding',
    rationale: 'old',
    dismissedAt: null,
  },
  {
    id: 'f1',
    reviewId: 'review-latest',
    file: 'src/auth.ts',
    startLine: 10,
    endLine: 12,
    severity: 'CRITICAL',
    category: 'security',
    title: 'SQL injection',
    rationale: OVERSIZED_RATIONALE,
    dismissedAt: null,
  },
  {
    id: 'f2',
    reviewId: 'review-latest',
    file: 'src/util.ts',
    startLine: 20,
    endLine: 21,
    severity: 'WARNING',
    category: 'style',
    title: 'Unused var',
    rationale: 'short rationale',
    dismissedAt: null,
  },
  {
    id: 'f3',
    reviewId: 'review-latest',
    file: 'src/util.ts',
    startLine: 30,
    endLine: 31,
    severity: 'WARNING',
    category: 'style',
    title: 'Dismissed one',
    rationale: 'dismissed rationale',
    dismissedAt: new Date('2026-07-02T00:00:00.000Z'),
  },
];

function baseFixtures(): Fixtures {
  return {
    pullRequests: [PR_ROW],
    prIntent: [INTENT_ROW],
    reviews: [REVIEW_LATEST, REVIEW_OLD],
    prFiles: PR_FILES,
    findings: FINDINGS,
  };
}

/** Recursively find any key EXACTLY named `patch` or `diff` at any depth (AC-5). Does
 * NOT flag `diffStats` — that field name is expected (composeSmartDiff's file-level
 * stats output), only a literal `diff`/`patch` key would indicate raw body content. */
function findForbiddenKeys(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object') return [];
  const hits: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findForbiddenKeys(v, `${path}[${i}]`)));
    return hits;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'patch' || key === 'diff') hits.push(`${path}.${key}`);
    hits.push(...findForbiddenKeys(v, `${path}.${key}`));
  }
  return hits;
}

describe('assembleBriefInput', () => {
  it('AC-5: the assembled input contains no diff/patch field anywhere', async () => {
    const container = makeContainer(baseFixtures());
    const result = await assembleBriefInput(container, WS_ID, PR_ID);
    expect(findForbiddenKeys(result)).toEqual([]);
  });

  it('AC-6: attached-spec entries carry path/title only, no body/content field', async () => {
    const agentId = 'agent-1';
    const fixtures = {
      ...baseFixtures(),
      reviews: [{ id: 'review-latest', prId: PR_ID, agentId }, REVIEW_OLD],
    };
    const container = makeContainer(fixtures, {
      agentsRepo: {
        getById: vi.fn().mockResolvedValue({ id: agentId, attachedContextPaths: ['docs/spec.md'] }),
        linkedSkills: vi.fn().mockResolvedValue([]),
      },
      context: { listPaths: vi.fn().mockResolvedValue(new Set(['docs/spec.md', 'README.md'])) },
    });

    const result = await assembleBriefInput(container, WS_ID, PR_ID);

    expect(result.attachedSpecs).toEqual([{ path: 'docs/spec.md', title: 'spec.md' }]);
    for (const spec of result.attachedSpecs) {
      expect(Object.keys(spec).sort()).toEqual(['path', 'title']);
    }
  });

  it('attached specs are empty when the latest review has no agentId (M4)', async () => {
    const container = makeContainer(baseFixtures()); // REVIEW_LATEST.agentId === null
    const result = await assembleBriefInput(container, WS_ID, PR_ID);
    expect(result.attachedSpecs).toEqual([]);
  });

  it('AC-8: a dismissed finding is excluded from the assembled finding set', async () => {
    const container = makeContainer(baseFixtures());
    const result = await assembleBriefInput(container, WS_ID, PR_ID);

    const ids = result.findings.map((f) => f.id);
    expect(ids).not.toContain('f3'); // dismissedAt set
    expect(ids).toEqual(expect.arrayContaining(['f1', 'f2']));
  });

  it('AC-11: the assembled finding set matches computeFindingsByPr for the same PR (shared latest-review definition)', async () => {
    const fixtures: Fixtures = {
      ...baseFixtures(),
      findingsCountRows: [
        { prId: PR_ID, severity: 'CRITICAL', count: 1 },
        { prId: PR_ID, severity: 'WARNING', count: 1 },
      ],
      titleRows: [
        { pr_id: PR_ID, severity: 'CRITICAL', id: 'f1', title: 'SQL injection' },
        { pr_id: PR_ID, severity: 'WARNING', id: 'f2', title: 'Unused var' },
      ],
    };
    const container = makeContainer(fixtures);
    const db = makeFakeDb(fixtures);

    const result = await assembleBriefInput(container, WS_ID, PR_ID);
    const bucketsByPr = await computeFindingsByPr(db as unknown as Db, [PR_ID]);

    // Both must resolve to the SAME latest review — never independently derived.
    expect(result.basedOn.reviewId).toBe('review-latest');

    const bucket = bucketsByPr.get(PR_ID);
    expect(bucket).toBeDefined();
    const idsFromComputeFindingsByPr = [
      ...(bucket?.CRITICAL.titles ?? []),
      ...(bucket?.WARNING.titles ?? []),
      ...(bucket?.SUGGESTION.titles ?? []),
    ].map((t2) => t2.id);

    const assembledIds = result.findings.map((f) => f.id);
    for (const id of idsFromComputeFindingsByPr) {
      expect(assembledIds).toContain(id);
    }
    // The older review's finding must never leak into either.
    expect(assembledIds).not.toContain('f-old-1');
  });

  it('AC-12: an oversized rationale is clipped, not dropped', async () => {
    const container = makeContainer(baseFixtures());
    const result = await assembleBriefInput(container, WS_ID, PR_ID);

    const f1 = result.findings.find((f) => f.id === 'f1');
    expect(f1).toBeDefined();
    expect(f1!.rationale.length).toBeLessThan(OVERSIZED_RATIONALE.length);
    expect(f1!.rationale.length).toBeLessThanOrEqual(RATIONALE_CLIP_CHARS + 1); // +1 for the ellipsis marker
    expect(f1!.rationale.startsWith('A'.repeat(RATIONALE_CLIP_CHARS))).toBe(true);
  });
});

describe('brief-synth.system.md', () => {
  it('AC-13: carries an untrusted-content clause', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const promptPath = join(here, '..', '..', '..', 'prompts', 'brief-synth.system.md');
    const content = readFileSync(promptPath, 'utf8');
    expect(content).toMatch(/untrusted/);
  });
});

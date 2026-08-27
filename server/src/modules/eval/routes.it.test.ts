import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StructuredRequest, StructuredResult } from '@devdigest/shared';
import { EvalDashboard, EvalDashboardIndex } from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from '../../../test/helpers/pg.js';
import { seed } from '../../db/seed.js';
import * as t from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../app.js';
import { MockLLMProvider, MockSecretsProvider } from '../../adapters/mocks.js';
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';

/**
 * Contract-tier integration test for the eval module (L06) — every frozen
 * boundary in `docs/features/2026-08-25-eval-pipeline/contract.md` §4, driven
 * against a real Postgres with a scripted (never-real) LLM.
 *
 * Only §4's server API is exercised here; the scorer's metric matrix itself
 * is covered exhaustively and hermetically by `pnpm verify:l06`
 * (`scoring.test.ts`) — this file verifies the WIRING: that the service
 * persists the right rows and hands the scorer the right inputs, not that
 * the scoring formulas are correct in isolation.
 */
const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[eval/routes] Docker not available — skipping integration tests.');
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** A single-file unified diff (with `diff --git`/`---`/`+++` headers) covering
 *  three consecutive new-side lines: `newStart`, `newStart+1`, `newStart+2`. */
function diffText(path: string, newStart: number): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${newStart},3 +${newStart},3 @@`,
    ` context line ${newStart}`,
    `+added line ${newStart + 1}`,
    ` context line ${newStart + 2}`,
  ].join('\n');
}

/** The `pr_files.patch` fragment ONLY (no `diff --git`/`+++` headers) —
 *  `assembleDiffFragment` adds those, mirroring contract §4.4 step 4. */
function patchOnly(newStart: number): string {
  return [
    `@@ -${newStart},3 +${newStart},3 @@`,
    ` context line ${newStart}`,
    `+added line ${newStart + 1}`,
    ` context line ${newStart + 2}`,
  ].join('\n');
}

/** A diff fragment that parses to zero files (contract §4.6 trap: bare `@@`
 *  with no `diff --git`/`+++` header). */
const ZERO_FILE_DIFF = '@@ -1,3 +1,3 @@\n context\n+added\n context';

interface MockFindingSpec {
  id: string;
  file: string;
  start_line: number;
  end_line: number;
}

/** A `Review` structured-output fixture with the given findings (or none). */
function mockReview(findings: MockFindingSpec[]) {
  return {
    verdict: 'comment' as const,
    summary: 'mock review summary',
    score: 70,
    findings: findings.map((f) => ({
      id: f.id,
      severity: 'WARNING' as const,
      category: 'bug' as const,
      title: `mock finding ${f.id}`,
      file: f.file,
      start_line: f.start_line,
      end_line: f.end_line,
      rationale: 'Mock rationale for deterministic scoring.',
      confidence: 0.9,
    })),
  };
}

/**
 * A scripted LLM double: extends `MockLLMProvider` (no real model is ever
 * called) but picks its fixture PER CASE by looking for the case's
 * `Eval case · <name>` task line inside the assembled user prompt
 * (contract §4.5 / `service.ts`'s `task` field) — cases run sequentially
 * against ONE shared provider instance per batch, so a fixed single-fixture
 * `MockLLMProvider` cannot make different cases return different findings.
 */
class ScriptedLLMProvider extends MockLLMProvider {
  constructor(private fixturesByCaseName: Record<string, ReturnType<typeof mockReview>>) {
    super('openai');
  }

  override async completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push({ method: 'completeStructured', req });
    const userMsg = String(req.messages.find((m) => m.role === 'user')?.content ?? '');
    const matchedName = Object.keys(this.fixturesByCaseName).find((name) =>
      userMsg.includes(`Eval case · ${name}`),
    );
    const fixture = matchedName
      ? this.fixturesByCaseName[matchedName]
      : { verdict: 'approve' as const, summary: 'no fixture configured', score: 95, findings: [] };
    const parsed = (req.schema as z.ZodType<T>).safeParse(fixture);
    if (!parsed.success) {
      throw new Error(
        `ScriptedLLMProvider: fixture for "${matchedName}" failed schema: ${parsed.error.message}`,
      );
    }
    return {
      data: parsed.data,
      model: req.model,
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.001,
      raw: JSON.stringify(fixture),
      attempts: 1,
    };
  }
}

async function makeAgent(
  db: Db,
  workspaceId: string,
  overrides: Partial<{ name: string; systemPrompt: string }> = {},
) {
  const [row] = await db
    .insert(t.agents)
    .values({
      workspaceId,
      name: overrides.name ?? `eval-agent-${randomUUID()}`,
      provider: 'openai',
      model: 'gpt-4.1',
      systemPrompt: overrides.systemPrompt ?? 'You are a careful reviewer. Flag real bugs only.',
    })
    .returning();
  return row!;
}

async function insertCase(
  db: Db,
  workspaceId: string,
  agentId: string,
  opts: { name: string; diff: string; kind: 'must_find' | 'must_not_flag'; file: string; startLine: number; endLine: number },
) {
  const [row] = await db
    .insert(t.evalCases)
    .values({
      workspaceId,
      ownerKind: 'agent',
      ownerId: agentId,
      name: opts.name,
      inputDiff: opts.diff,
      inputFiles: null,
      inputMeta: { origin: 'manual', source_finding_id: null, source_pr_id: null, source_review_id: null },
      expectedOutput: { kind: opts.kind, file: opts.file, start_line: opts.startLine, end_line: opts.endLine },
      notes: null,
    })
    .returning();
  return row!;
}

async function makePrWithFile(
  db: Db,
  workspaceId: string,
  file: { path: string; patch: string | null } | null,
) {
  const [repo] = await db
    .insert(t.repos)
    .values({ workspaceId, owner: 'acme', name: `eval-repo-${randomUUID()}`, fullName: `acme/eval-repo-${randomUUID()}` })
    .returning();
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId,
      repoId: repo!.id,
      number: 1,
      title: 'Eval fixture PR',
      author: 'tester',
      branch: 'feat/eval-fixture',
      base: 'main',
      headSha: 'sha-eval-fixture',
      status: 'needs_review',
    })
    .returning();
  if (file) {
    await db.insert(t.prFiles).values({ prId: pr!.id, path: file.path, patch: file.patch, additions: 1, deletions: 0 });
  }
  return { repo: repo!, pr: pr! };
}

async function makeReviewWithFinding(
  db: Db,
  workspaceId: string,
  prId: string,
  agentId: string | null,
  finding: {
    file: string;
    startLine: number;
    endLine: number;
    title: string;
    acceptedAt?: Date | null;
    dismissedAt?: Date | null;
  },
) {
  const [review] = await db
    .insert(t.reviews)
    .values({ workspaceId, prId, agentId, kind: 'review' })
    .returning();
  const [findingRow] = await db
    .insert(t.findings)
    .values({
      reviewId: review!.id,
      file: finding.file,
      startLine: finding.startLine,
      endLine: finding.endLine,
      severity: 'WARNING',
      category: 'bug',
      title: finding.title,
      rationale: 'Because the fixture says so.',
      confidence: 0.9,
      acceptedAt: finding.acceptedAt ?? null,
      dismissedAt: finding.dismissedAt ?? null,
    })
    .returning();
  return { review: review!, finding: findingRow! };
}

/** Run a batch through a throwaway app instance so a test can swap the LLM
 *  double between two runs of the SAME agent without mutating the shared
 *  `app`. Safe to `.close()` — `buildApp` never closes an externally-owned
 *  `db` handle (`server/src/app.ts:41-42`). */
async function runBatch(
  db: Db,
  agentId: string,
  fixturesByCaseName: Record<string, ReturnType<typeof mockReview>>,
  caseIds?: string[],
) {
  const llm = new ScriptedLLMProvider(fixturesByCaseName);
  const localApp = await buildApp({ db, overrides: { llm: { openai: llm }, secrets: new MockSecretsProvider() } });
  const res = await localApp.inject({
    method: 'POST',
    url: `/agents/${agentId}/eval-runs`,
    payload: caseIds ? { case_ids: caseIds } : {},
  });
  await localApp.close();
  return { res, llm };
}

d('eval routes (contract §4)', () => {
  let pg: PgFixture;
  let app: FastifyInstance;
  let workspaceId: string;

  beforeAll(async () => {
    pg = await startPg();
  });

  afterAll(async () => {
    await app?.close();
    await pg?.stop();
  });

  beforeEach(async () => {
    const { db } = pg.handle;
    // Clean eval + PR-scoped tables between tests; cascades handle prFiles/
    // prCommits/reviews/findings via pullRequests, and eval_runs via eval_cases
    // / eval_run_batches.
    await db.delete(t.evalRuns);
    await db.delete(t.evalRunBatches);
    await db.delete(t.evalCases);
    await db.delete(t.pullRequests);
    await db.delete(t.agents);
    await db.delete(t.repos);

    const seeded = await seed(db);
    workspaceId = seeded.workspaceId;

    app = await buildApp({ db, overrides: { secrets: new MockSecretsProvider() } });
  });

  // =========================================================================
  // Case creation from a finding (contract §4.4)
  // =========================================================================

  describe('POST /eval-cases/from-finding', () => {
    it('an ACCEPTED finding yields a must_find case with the finding file and line range', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);
      const { pr } = await makePrWithFile(db, workspaceId, { path: 'src/accepted.ts', patch: patchOnly(9) });
      const { finding } = await makeReviewWithFinding(db, workspaceId, pr.id, agent.id, {
        file: 'src/accepted.ts',
        startLine: 10,
        endLine: 10,
        title: 'Hardcoded API key',
        acceptedAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/eval-cases/from-finding',
        payload: { finding_id: finding.id },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.expected_output.kind).toBe('must_find');
      expect(body.expected_output.file).toBe('src/accepted.ts');
      expect(body.expected_output.start_line).toBe(10);
      expect(body.expected_output.end_line).toBe(10);
    });

    it('a DISMISSED finding yields a must_not_flag case', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);
      const { pr } = await makePrWithFile(db, workspaceId, { path: 'src/dismissed.ts', patch: patchOnly(9) });
      const { finding } = await makeReviewWithFinding(db, workspaceId, pr.id, agent.id, {
        file: 'src/dismissed.ts',
        startLine: 10,
        endLine: 10,
        title: 'False positive on test fixture',
        dismissedAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/eval-cases/from-finding',
        payload: { finding_id: finding.id },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().expected_output.kind).toBe('must_not_flag');
    });

    it('a finding with neither decision returns 422 and creates no case', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);
      const { pr } = await makePrWithFile(db, workspaceId, { path: 'src/undecided.ts', patch: patchOnly(9) });
      const { finding } = await makeReviewWithFinding(db, workspaceId, pr.id, agent.id, {
        file: 'src/undecided.ts',
        startLine: 10,
        endLine: 10,
        title: 'Not yet judged',
      });

      const before = await db.select().from(t.evalCases).where(eq(t.evalCases.ownerId, agent.id));
      expect(before).toHaveLength(0);

      const res = await app.inject({
        method: 'POST',
        url: '/eval-cases/from-finding',
        payload: { finding_id: finding.id },
      });

      expect(res.statusCode).toBe(422);
      const after = await db.select().from(t.evalCases).where(eq(t.evalCases.ownerId, agent.id));
      expect(after).toHaveLength(0);
    });

    it('is idempotent: re-posting the same finding_id yields ONE case (201 then 200 with the same id)', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);
      const { pr } = await makePrWithFile(db, workspaceId, { path: 'src/repeat.ts', patch: patchOnly(9) });
      const { finding } = await makeReviewWithFinding(db, workspaceId, pr.id, agent.id, {
        file: 'src/repeat.ts',
        startLine: 10,
        endLine: 10,
        title: 'Repeatable finding',
        acceptedAt: new Date(),
      });

      const first = await app.inject({
        method: 'POST',
        url: '/eval-cases/from-finding',
        payload: { finding_id: finding.id },
      });
      expect(first.statusCode).toBe(201);
      const firstId = first.json().id;

      const second = await app.inject({
        method: 'POST',
        url: '/eval-cases/from-finding',
        payload: { finding_id: finding.id },
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().id).toBe(firstId);

      const rows = await db.select().from(t.evalCases).where(eq(t.evalCases.ownerId, agent.id));
      expect(rows).toHaveLength(1);
    });

    it('assembles input_diff from the stored pr_files.patch, and it parses to exactly one file', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);
      const { pr } = await makePrWithFile(db, workspaceId, { path: 'src/parseable.ts', patch: patchOnly(20) });
      const { finding } = await makeReviewWithFinding(db, workspaceId, pr.id, agent.id, {
        file: 'src/parseable.ts',
        startLine: 21,
        endLine: 21,
        title: 'Parseable diff fragment',
        acceptedAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/eval-cases/from-finding',
        payload: { finding_id: finding.id },
      });

      expect(res.statusCode).toBe(201);
      const inputDiff = res.json().input_diff as string;
      const parsed = parseUnifiedDiff(inputDiff);
      expect(parsed.files).toHaveLength(1);
      expect(parsed.files[0]!.path).toBe('src/parseable.ts');
    });

    it('a finding whose file has no stored patch returns 422 and creates no case', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);
      // No pr_files row at all for this path.
      const { pr } = await makePrWithFile(db, workspaceId, null);
      const { finding } = await makeReviewWithFinding(db, workspaceId, pr.id, agent.id, {
        file: 'src/no-patch.ts',
        startLine: 5,
        endLine: 5,
        title: 'File never had a stored patch',
        acceptedAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/eval-cases/from-finding',
        payload: { finding_id: finding.id },
      });

      expect(res.statusCode).toBe(422);
      const rows = await db.select().from(t.evalCases).where(eq(t.evalCases.ownerId, agent.id));
      expect(rows).toHaveLength(0);
    });
  });

  // =========================================================================
  // Runs (contract §4.1, §4.5, §4.6)
  // =========================================================================

  describe('POST /agents/:id/eval-runs', () => {
    it('persists one eval_run_batches row and one eval_runs row per case (all carrying batch_id), scored to hand-computed metrics', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);

      // case-a (must_find, file a.ts lines 10-10): the provider returns the
      // matching finding PLUS a second, non-matching-but-kept finding at
      // line 11 (also inside the diff's hunk) — exercises "pass but noisy"
      // (contract §3.2/§3.3): only the first match is credited as TP, the
      // second still lowers precision.
      const caseA = await insertCase(db, workspaceId, agent.id, {
        name: 'case-a', diff: diffText('src/a.ts', 9), kind: 'must_find', file: 'src/a.ts', startLine: 10, endLine: 10,
      });
      // case-b (must_find, file b.ts lines 10-10): the provider's finding is
      // OUTSIDE the diff's hunk (line 999) — grounding drops it, so it never
      // reaches the scorer at all (kept = 0, dropped = 1).
      const caseB = await insertCase(db, workspaceId, agent.id, {
        name: 'case-b', diff: diffText('src/b.ts', 9), kind: 'must_find', file: 'src/b.ts', startLine: 10, endLine: 10,
      });
      // case-c (must_not_flag, file c.ts lines 10-10): the provider reports
      // nothing — the case passes cleanly.
      const caseC = await insertCase(db, workspaceId, agent.id, {
        name: 'case-c', diff: diffText('src/c.ts', 9), kind: 'must_not_flag', file: 'src/c.ts', startLine: 10, endLine: 10,
      });

      const { res } = await runBatch(db, agent.id, {
        'case-a': mockReview([
          { id: 'fa1', file: 'src/a.ts', start_line: 10, end_line: 10 },
          { id: 'fa2', file: 'src/a.ts', start_line: 11, end_line: 11 },
        ]),
        'case-b': mockReview([{ id: 'fb1', file: 'src/b.ts', start_line: 999, end_line: 999 }]),
        'case-c': mockReview([]),
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();

      // Hand-computed (contract §3.3):
      //   TP = 1 (only case-a's first finding matches; case-b's kept-set is
      //           empty because grounding dropped its only finding)
      //   MF = 2 (case-a, case-b are must_find)      → recall = 1/2 = 0.5
      //   F  = 2 (case-a's 2 kept findings; case-b/c contribute 0 kept)
      //                                                → precision = 1/2 = 0.5
      //   kept = 2, dropped = 1                        → citation_accuracy = 2/3
      //   traces_passed = 2 (case-a passes despite noise; case-c passes; case-b fails)
      expect(body.batch.cases_total).toBe(3);
      expect(body.batch.recall).toBe(0.5);
      expect(body.batch.precision).toBe(0.5);
      expect(body.batch.citation_accuracy).toBeCloseTo(2 / 3, 6);
      expect(body.batch.traces_passed).toBe(2);

      const batchRows = await db.select().from(t.evalRunBatches).where(eq(t.evalRunBatches.id, body.batch.id));
      expect(batchRows).toHaveLength(1);

      const runRows = await db.select().from(t.evalRuns).where(eq(t.evalRuns.batchId, body.batch.id));
      expect(runRows).toHaveLength(3);
      expect(runRows.every((r) => r.batchId === body.batch.id)).toBe(true);
      expect(new Set(runRows.map((r) => r.caseId))).toEqual(new Set([caseA.id, caseB.id, caseC.id]));
    });

    it('scores precision and citation_accuracy PER CASE, leaving per-case recall null', async () => {
      // Regression guard. These three columns exist on `eval_runs` and the
      // case-editor modal renders them; before this was scored, every run row
      // held NULL for all three and the modal showed three permanent
      // em-dashes for passing and failing cases alike.
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);

      // Same three shapes as the batch test above, chosen because between them
      // they cover every branch of a per-case ratio: a real one, a zero with a
      // denominator, and both flavours of vacuous null.
      const caseA = await insertCase(db, workspaceId, agent.id, {
        name: 'case-a', diff: diffText('src/a.ts', 9), kind: 'must_find', file: 'src/a.ts', startLine: 10, endLine: 10,
      });
      const caseB = await insertCase(db, workspaceId, agent.id, {
        name: 'case-b', diff: diffText('src/b.ts', 9), kind: 'must_find', file: 'src/b.ts', startLine: 10, endLine: 10,
      });
      const caseC = await insertCase(db, workspaceId, agent.id, {
        name: 'case-c', diff: diffText('src/c.ts', 9), kind: 'must_not_flag', file: 'src/c.ts', startLine: 10, endLine: 10,
      });

      const { res } = await runBatch(db, agent.id, {
        'case-a': mockReview([
          { id: 'fa1', file: 'src/a.ts', start_line: 10, end_line: 10 },
          { id: 'fa2', file: 'src/a.ts', start_line: 11, end_line: 11 },
        ]),
        'case-b': mockReview([{ id: 'fb1', file: 'src/b.ts', start_line: 999, end_line: 999 }]),
        'case-c': mockReview([]),
      });
      expect(res.statusCode).toBe(201);

      type CaseRow = { precision: number | null; citation_accuracy: number | null; recall: number | null };
      const byId = new Map<string, CaseRow>(
        (res.json().cases as ({ case_id: string } & CaseRow)[]).map((c) => [c.case_id, c]),
      );
      // Missing row is a failure in its own right, not an `undefined` that
      // silently makes the metric assertions below vacuous.
      const scored = (id: string): CaseRow => {
        const row = byId.get(id);
        if (!row) throw new Error(`batch has no run row for case ${id}`);
        return row;
      };

      // case-a: 2 kept findings, 1 of them the TP → precision 1/2;
      //         nothing dropped → citation 2/2.
      expect(scored(caseA.id).precision).toBe(0.5);
      expect(scored(caseA.id).citation_accuracy).toBe(1);

      // case-b: its only finding was dropped by grounding → no findings left,
      //         so precision has no denominator; citation DOES have one and is
      //         a true zero (0 kept of 1 offered). The two must not collapse.
      expect(scored(caseB.id).precision).toBeNull();
      expect(scored(caseB.id).citation_accuracy).toBe(0);

      // case-c: the provider reported nothing at all → both denominators empty.
      expect(scored(caseC.id).precision).toBeNull();
      expect(scored(caseC.id).citation_accuracy).toBeNull();

      // recall stays null on every row: a single case's denominator is its own
      // lone expectation, so the value would only restate `pass`.
      for (const id of [caseA.id, caseB.id, caseC.id]) {
        expect(scored(id).recall).toBeNull();
      }

      // and the same values are what actually landed in the table
      const rows = await db.select().from(t.evalRuns).where(eq(t.evalRuns.batchId, res.json().batch.id));
      expect(rows.find((r) => r.caseId === caseA.id)!.precision).toBe(0.5);
      expect(rows.every((r) => r.recall === null)).toBe(true);
    });

    it('case_ids restricts the batch to exactly that subset', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);
      const caseX = await insertCase(db, workspaceId, agent.id, {
        name: 'case-x', diff: diffText('src/x.ts', 9), kind: 'must_find', file: 'src/x.ts', startLine: 10, endLine: 10,
      });
      await insertCase(db, workspaceId, agent.id, {
        name: 'case-y', diff: diffText('src/y.ts', 9), kind: 'must_find', file: 'src/y.ts', startLine: 10, endLine: 10,
      });

      const { res, llm } = await runBatch(
        db,
        agent.id,
        { 'case-x': mockReview([{ id: 'fx1', file: 'src/x.ts', start_line: 10, end_line: 10 }]) },
        [caseX.id],
      );

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.batch.cases_total).toBe(1);
      expect(body.cases).toHaveLength(1);
      expect(body.cases[0]!.case_id).toBe(caseX.id);
      // Only the requested case ever reached the LLM.
      expect(llm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);

      const runRows = await db.select().from(t.evalRuns).where(eq(t.evalRuns.batchId, body.batch.id));
      expect(runRows).toHaveLength(1);
    });

    it('an agent with zero eval cases returns 422 and creates no batch row', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);

      const before = await db.select().from(t.evalRunBatches).where(eq(t.evalRunBatches.ownerId, agent.id));
      expect(before).toHaveLength(0);

      const res = await app.inject({ method: 'POST', url: `/agents/${agent.id}/eval-runs`, payload: {} });
      expect(res.statusCode).toBe(422);

      const after = await db.select().from(t.evalRunBatches).where(eq(t.evalRunBatches.ownerId, agent.id));
      expect(after).toHaveLength(0);
    });

    it('accepts a POST with NO body at all as "run every case" — the shape the client actually sends', async () => {
      // Regression guard. The client omits the body entirely for run-all, and
      // `apiFetch` then omits content-type too, so Fastify hands the route a
      // null body. Every other test here materialises `payload: {}`, which
      // passes the object schema and hides the real wire shape — this one must
      // send nothing at all, or it is not testing the failing case.
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);
      await insertCase(db, workspaceId, agent.id, {
        name: 'case-nobody', diff: diffText('src/a.ts', 9), kind: 'must_find',
        file: 'src/a.ts', startLine: 10, endLine: 10,
      });

      const llm = new ScriptedLLMProvider({ 'case-nobody': mockReview([]) });
      const localApp = await buildApp({
        db,
        overrides: { llm: { openai: llm }, secrets: new MockSecretsProvider() },
      });
      const res = await localApp.inject({
        method: 'POST',
        url: `/agents/${agent.id}/eval-runs`,
      });
      await localApp.close();

      expect(res.statusCode).toBe(201);
      expect(res.json().batch.cases_total).toBe(1);
    });

    it('snapshots system_prompt verbatim per batch; a batch run after a prompt edit carries the NEW prompt while the older batch keeps the OLD one', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId, { systemPrompt: 'PROMPT_V1 — review carefully.' });
      await insertCase(db, workspaceId, agent.id, {
        name: 'case-snap', diff: diffText('src/snap.ts', 9), kind: 'must_not_flag', file: 'src/snap.ts', startLine: 10, endLine: 10,
      });

      const { res: res1 } = await runBatch(db, agent.id, { 'case-snap': mockReview([]) });
      expect(res1.statusCode).toBe(201);
      const batch1Id = res1.json().batch.id;

      await db.update(t.agents).set({ systemPrompt: 'PROMPT_V2 — review even more carefully.' }).where(eq(t.agents.id, agent.id));

      const { res: res2 } = await runBatch(db, agent.id, { 'case-snap': mockReview([]) });
      expect(res2.statusCode).toBe(201);
      const batch2Id = res2.json().batch.id;

      const detail1 = await app.inject({ method: 'GET', url: `/agents/${agent.id}/eval-runs/${batch1Id}` });
      const detail2 = await app.inject({ method: 'GET', url: `/agents/${agent.id}/eval-runs/${batch2Id}` });
      expect(detail1.json().system_prompt).toBe('PROMPT_V1 — review carefully.');
      expect(detail2.json().system_prompt).toBe('PROMPT_V2 — review even more carefully.');
    });

    it('per-case failure isolation: a diff that parses to zero files is recorded as failed, the batch still succeeds, and it counts as missed in recall', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);
      const caseOk = await insertCase(db, workspaceId, agent.id, {
        name: 'case-ok', diff: diffText('src/ok.ts', 9), kind: 'must_find', file: 'src/ok.ts', startLine: 10, endLine: 10,
      });
      const caseBad = await insertCase(db, workspaceId, agent.id, {
        name: 'case-bad', diff: ZERO_FILE_DIFF, kind: 'must_find', file: 'src/bad.ts', startLine: 1, endLine: 1,
      });

      const { res, llm } = await runBatch(db, agent.id, {
        'case-ok': mockReview([{ id: 'fok', file: 'src/ok.ts', start_line: 10, end_line: 10 }]),
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.batch.status).toBe('succeeded');
      expect(body.batch.cases_total).toBe(2);
      // TP = 1, MF = 2 (case-bad's must_find counts as missed) → recall = 0.5, not 1.
      expect(body.batch.recall).toBe(0.5);
      expect(body.batch.traces_passed).toBe(1);

      // The bad case never reaches the LLM at all — only case-ok does.
      expect(llm.calls.filter((c) => c.method === 'completeStructured')).toHaveLength(1);

      const runRows = await db.select().from(t.evalRuns).where(eq(t.evalRuns.batchId, body.batch.id));
      expect(runRows).toHaveLength(2);
      const badRun = runRows.find((r) => r.caseId === caseBad.id);
      expect(badRun?.pass).toBe(false);
      expect((badRun?.actualOutput as { error?: string } | null)?.error).toBe('diff fragment parsed to zero files');
      const okRun = runRows.find((r) => r.caseId === caseOk.id);
      expect(okRun?.pass).toBe(true);
    });
  });

  // =========================================================================
  // Compare and dashboard (contract §4.1, §4.3)
  // =========================================================================

  describe('GET /agents/:id/eval-runs/compare', () => {
    it('returns both prompts and deltas, ordering a as the older run even when the query names them the other way round', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId, { systemPrompt: 'PROMPT_V1' });
      await insertCase(db, workspaceId, agent.id, {
        name: 'case-d', diff: diffText('src/d.ts', 9), kind: 'must_find', file: 'src/d.ts', startLine: 10, endLine: 10,
      });
      await insertCase(db, workspaceId, agent.id, {
        name: 'case-e', diff: diffText('src/e.ts', 9), kind: 'must_not_flag', file: 'src/e.ts', startLine: 10, endLine: 10,
      });

      const { res: res1 } = await runBatch(db, agent.id, {
        'case-d': mockReview([{ id: 'fd1', file: 'src/d.ts', start_line: 10, end_line: 10 }]),
        'case-e': mockReview([]),
      });
      expect(res1.statusCode).toBe(201);
      const batch1 = res1.json().batch;
      // TP=1, MF=1 → recall = 1.
      expect(batch1.recall).toBe(1);

      await db.update(t.agents).set({ systemPrompt: 'PROMPT_V2' }).where(eq(t.agents.id, agent.id));

      const { res: res2 } = await runBatch(db, agent.id, {
        'case-d': mockReview([]), // no longer finds it
        'case-e': mockReview([]),
      });
      expect(res2.statusCode).toBe(201);
      const batch2 = res2.json().batch;
      // TP=0, MF=1 → recall = 0.
      expect(batch2.recall).toBe(0);

      // Query with the NEWER batch named `a` and the OLDER named `b`.
      const compareRes = await app.inject({
        method: 'GET',
        url: `/agents/${agent.id}/eval-runs/compare?a=${batch2.id}&b=${batch1.id}`,
      });

      expect(compareRes.statusCode).toBe(200);
      const cmp = compareRes.json();
      expect(cmp.a.id).toBe(batch1.id); // swapped: a is always the older run
      expect(cmp.b.id).toBe(batch2.id);
      expect(cmp.system_prompt_a).toBe('PROMPT_V1');
      expect(cmp.system_prompt_b).toBe('PROMPT_V2');
      expect(cmp.delta.recall).toBe(-1); // b.recall - a.recall = 0 - 1
    });

    it('returns 404 when a batch belongs to a different agent', async () => {
      const { db } = pg.handle;
      const agentA = await makeAgent(db, workspaceId);
      const agentB = await makeAgent(db, workspaceId);
      await insertCase(db, workspaceId, agentA.id, {
        name: 'case-a1', diff: diffText('src/a1.ts', 9), kind: 'must_not_flag', file: 'src/a1.ts', startLine: 10, endLine: 10,
      });
      await insertCase(db, workspaceId, agentB.id, {
        name: 'case-b1', diff: diffText('src/b1.ts', 9), kind: 'must_not_flag', file: 'src/b1.ts', startLine: 10, endLine: 10,
      });

      const { res: resA } = await runBatch(db, agentA.id, { 'case-a1': mockReview([]) });
      const { res: resB } = await runBatch(db, agentB.id, { 'case-b1': mockReview([]) });
      const batchA = resA.json().batch;
      const batchB = resB.json().batch;

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${agentA.id}/eval-runs/compare?a=${batchA.id}&b=${batchB.id}`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /eval-dashboard and /eval-dashboard/:agentId', () => {
    it('returns the shapes the contracts declare, with our agent present', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);
      await insertCase(db, workspaceId, agent.id, {
        name: 'case-dash', diff: diffText('src/dash.ts', 9), kind: 'must_find', file: 'src/dash.ts', startLine: 10, endLine: 10,
      });
      const { res } = await runBatch(db, agent.id, {
        'case-dash': mockReview([{ id: 'fdash', file: 'src/dash.ts', start_line: 10, end_line: 10 }]),
      });
      expect(res.statusCode).toBe(201);
      const batch = res.json().batch;

      const indexRes = await app.inject({ method: 'GET', url: '/eval-dashboard' });
      expect(indexRes.statusCode).toBe(200);
      const indexBody = EvalDashboardIndex.parse(indexRes.json());
      const summary = indexBody.agents.find((a) => a.agent_id === agent.id);
      expect(summary).toBeDefined();
      expect(summary!.cases_total).toBe(1);
      expect(summary!.last_run?.id).toBe(batch.id);
      const recentEntry = indexBody.recent_runs.find((r) => r.id === batch.id);
      expect(recentEntry?.agent_name).toBe(agent.name);

      const agentDashRes = await app.inject({ method: 'GET', url: `/eval-dashboard/${agent.id}` });
      expect(agentDashRes.statusCode).toBe(200);
      const agentDash = EvalDashboard.parse(agentDashRes.json());
      expect(agentDash.owner_id).toBe(agent.id);
      expect(agentDash.cases_total).toBe(1);
      expect(agentDash.current.recall).toBe(1);
      // Single batch → no previous run to diff against.
      expect(agentDash.delta.recall).toBeNull();
      expect(agentDash.delta.precision).toBeNull();
      expect(agentDash.delta.citation_accuracy).toBeNull();
      expect(agentDash.alert).toBeNull();
    });

    it('a null metric (vacuous denominator) survives the round trip as null, not coerced to zero', async () => {
      const { db } = pg.handle;
      const agent = await makeAgent(db, workspaceId);
      // Only must_not_flag cases → MF = 0 → recall = null (contract §3.4).
      await insertCase(db, workspaceId, agent.id, {
        name: 'case-null-1', diff: diffText('src/n1.ts', 9), kind: 'must_not_flag', file: 'src/n1.ts', startLine: 10, endLine: 10,
      });
      await insertCase(db, workspaceId, agent.id, {
        name: 'case-null-2', diff: diffText('src/n2.ts', 9), kind: 'must_not_flag', file: 'src/n2.ts', startLine: 10, endLine: 10,
      });

      const { res } = await runBatch(db, agent.id, {
        'case-null-1': mockReview([]),
        'case-null-2': mockReview([]),
      });
      expect(res.statusCode).toBe(201);
      const batch = res.json().batch;
      expect(batch.recall).toBeNull();

      const agentDashRes = await app.inject({ method: 'GET', url: `/eval-dashboard/${agent.id}` });
      expect(agentDashRes.statusCode).toBe(200);
      const agentDash = EvalDashboard.parse(agentDashRes.json());
      expect(agentDash.current.recall).toBeNull();
      // A batch with any null metric is omitted from the trend series
      // rather than coerced (contract §3.4).
      expect(agentDash.trend).toHaveLength(0);
    });
  });
});

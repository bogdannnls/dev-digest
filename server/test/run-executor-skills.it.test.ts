/**
 * Integration test: Spec D — run-executor wires enabled linked-skill bodies
 * into the production review path.
 *
 * Strategy: inject a MockLLMProvider and inspect the messages it receives.
 * The `## Skills / rules` section appears in the user message when skills are
 * passed. When no enabled skills exist the section is absent (identical prompt
 * to pre-Spec-D behaviour).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { waitForPrRuns } from './helpers/runs.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockLLMProvider, MockEmbedder, MockGitClient } from '../src/adapters/mocks.js';
import { AgentsRepository } from '../src/modules/agents/repository.js';
import * as t from '../src/db/schema.js';
import type { Review } from '@devdigest/shared';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[run-executor-skills] Docker not available — skipping.');
}

/** A minimal Review fixture accepted by the Review Zod schema. */
const REVIEW_FIXTURE: Review = {
  verdict: 'approve',
  summary: 'LGTM',
  score: 90,
  findings: [],
};

/** A diff with one changed file so grounding doesn't drop everything. */
const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  timeout: 5000,
   redisUrl: x,`;

let repoSeq = 0;
async function seedPr(db: PgFixture['handle']['db'], workspaceId: string) {
  const name = `skills-test-${repoSeq++}`;
  const [repo] = await db
    .insert(t.repos)
    .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
    .returning();
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId,
      repoId: repo!.id,
      number: 101,
      title: 'Add timeout',
      author: 'dev',
      branch: 'feat/timeout',
      base: 'main',
      headSha: 'deadbeef',
      additions: 1,
      deletions: 0,
      filesCount: 1,
      status: 'needs_review',
      body: null,
    })
    .returning();
  await db.insert(t.prFiles).values({
    prId: pr!.id,
    path: 'src/config.ts',
    additions: 1,
    deletions: 0,
    patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  timeout: 5000,\n   redisUrl: x,',
  });
  return { repo: repo!, pr: pr! };
}

d('run-executor: linked skills wiring (Spec D)', () => {
  let pg: PgFixture;
  let workspaceId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function config() {
    return loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  }

  /** Build an app with the given MockLLMProvider injected. */
  function appWith(mockLlm: MockLLMProvider) {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        git: new MockGitClient({ diff: DIFF }),
        llm: { openai: mockLlm },
      },
    });
  }

  async function createAgent(app: Awaited<ReturnType<typeof appWith>>) {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: `skill-executor-agent-${Date.now()}`,
        provider: 'openai',
        model: 'gpt-4o-mini',
        system_prompt: 'review the diff',
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function createSkill(app: Awaited<ReturnType<typeof appWith>>, name: string, body: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: { name, type: 'rubric', body },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  /**
   * Trigger a review run and wait for it to reach a terminal status.
   * Returns the captured user message content from the first LLM call.
   */
  async function runReview(
    app: Awaited<ReturnType<typeof appWith>>,
    mockLlm: MockLLMProvider,
    prId: string,
    agentId: string,
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: `/pulls/${prId}/review`,
      payload: { agentId },
    });
    expect(res.statusCode).toBe(200);
    await waitForPrRuns(pg.handle.db, prId, { expected: 1 });

    // The MockLLMProvider records every completeStructured call.
    // Each call's messages[1].content is the user turn (which contains Skills/rules).
    const structuredCalls = mockLlm.calls.filter((c) => c.method === 'completeStructured');
    expect(structuredCalls.length).toBeGreaterThan(0);
    const firstCall = structuredCalls[0]!.req as { messages: { role: string; content: string }[] };
    return firstCall.messages[1]!.content;
  }

  it('passes enabled skill bodies (in order) to reviewPullRequest; omits disabled', async () => {
    const mockLlm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
    const app = await appWith(mockLlm);
    const repo = new AgentsRepository(pg.handle.db);

    const agentId = await createAgent(app);
    const { pr } = await seedPr(pg.handle.db, workspaceId);

    // Three skills: order 0 (enabled), 1 (disabled), 2 (enabled).
    const sA = await createSkill(app, `skill-A-${Date.now()}`, 'SKILL-A body');
    const sB = await createSkill(app, `skill-B-${Date.now()}`, 'SKILL-B body');
    const sC = await createSkill(app, `skill-C-${Date.now()}`, 'SKILL-C body');

    await repo.linkSkill(agentId, sA, 0, true);
    await repo.linkSkill(agentId, sB, 1, false); // disabled — must be omitted
    await repo.linkSkill(agentId, sC, 2, true);

    const userContent = await runReview(app, mockLlm, pr.id, agentId);

    // Verify the run completed successfully — if the fixture is invalid the mock
    // throws, per-agent isolation catches it, and the run ends as 'failed'.
    const runs = await waitForPrRuns(pg.handle.db, pr.id, { expected: 1 });
    expect(runs[0]!.status).toBe('done');

    // The skills section must be present and contain exactly the two enabled bodies
    // in the correct order (A before C), with B absent.
    expect(userContent).toContain('## Skills / rules');
    expect(userContent).toContain('SKILL-A body');
    expect(userContent).toContain('SKILL-C body');
    expect(userContent).not.toContain('SKILL-B body');
    // A must appear before C
    expect(userContent.indexOf('SKILL-A body')).toBeLessThan(userContent.indexOf('SKILL-C body'));

    await app.close();
  });

  it('omits the skills section entirely when no enabled links exist', async () => {
    const mockLlm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
    const app = await appWith(mockLlm);
    const repo = new AgentsRepository(pg.handle.db);

    const agentId = await createAgent(app);
    const { pr } = await seedPr(pg.handle.db, workspaceId);

    // One skill linked but explicitly disabled — no enabled bodies.
    const sX = await createSkill(app, `skill-X-${Date.now()}`, 'SKILL-X body');
    await repo.linkSkill(agentId, sX, 0, false);

    const userContent = await runReview(app, mockLlm, pr.id, agentId);

    // Verify the run completed successfully.
    const runs = await waitForPrRuns(pg.handle.db, pr.id, { expected: 1 });
    expect(runs[0]!.status).toBe('done');

    // The skills section must be absent — prompt identical to pre-Spec-D shape.
    expect(userContent).not.toContain('## Skills / rules');
    expect(userContent).not.toContain('SKILL-X body');

    await app.close();
  });
});

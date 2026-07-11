/**
 * Integration test: Spec D — GET /agents/eval-fixtures + POST /agents/:id/skills-eval
 *
 * Tests the two new routes added in Task 7:
 *  - GET  /agents/eval-fixtures  → PRFixtureMeta[] (sorted by id)
 *  - POST /agents/:id/skills-eval { fixture_id } → SkillsEvalResult
 *
 * Uses MockLLMProvider to avoid real LLM calls. The mock returns a minimal
 * valid Review fixture so the grounding/serialization pipeline runs end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockLLMProvider, MockEmbedder } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';
import type { Review } from '@devdigest/shared';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[skills-eval] Docker not available — skipping.');
}

/** Minimal Review accepted by the Review Zod schema. */
const REVIEW_FIXTURE: Review = {
  verdict: 'approve',
  summary: 'LGTM',
  score: 90,
  findings: [],
};

d('GET /agents/eval-fixtures + POST /agents/:id/skills-eval', () => {
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

  /** Build an app with both providers mocked to return the standard REVIEW_FIXTURE. */
  function makeMockApp() {
    const mockAnthropicLlm = new MockLLMProvider('anthropic', { structured: REVIEW_FIXTURE });
    const mockOpenaiLlm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        embedder: new MockEmbedder(),
        llm: { anthropic: mockAnthropicLlm, openai: mockOpenaiLlm },
      },
    });
  }

  /** Build an app without LLM mock (for non-eval routes like create/query). */
  function makePlainApp() {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: { embedder: new MockEmbedder() },
    });
  }

  /**
   * Seed an agent in the default workspace + a linked enabled skill, then
   * return the agent id. Uses the HTTP API so workspace scoping goes through
   * the same path as production.
   */
  async function seedAgentWithSkill(app: Awaited<ReturnType<typeof makePlainApp>>): Promise<string> {
    const agentRes = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: `eval-agent-${Date.now()}`,
        provider: 'openai',
        model: 'gpt-4o-mini',
        system_prompt: 'review the diff',
      },
    });
    expect(agentRes.statusCode).toBe(201);
    const agentId = agentRes.json().id as string;

    const skillRes = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: { name: `eval-skill-${Date.now()}`, type: 'rubric', body: '## Check it' },
    });
    expect(skillRes.statusCode).toBe(201);
    const skillId = skillRes.json().id as string;

    const linkRes = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { skill_id: skillId, enabled: true },
    });
    expect(linkRes.statusCode).toBe(200);

    return agentId;
  }

  /**
   * Seed an agent directly in a SECOND workspace (no HTTP — direct DB insert)
   * so we can test cross-workspace isolation.
   */
  async function seedAgentInOtherWorkspace(): Promise<string> {
    const [otherWs] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: 'other-workspace' })
      .returning();

    const [agent] = await pg.handle.db
      .insert(t.agents)
      .values({
        workspaceId: otherWs!.id,
        name: 'cross-ws-agent',
        provider: 'openai',
        model: 'gpt-4o-mini',
        systemPrompt: 'review',
      })
      .returning();

    return agent!.id;
  }

  // ---------------------------------------------------------------------------
  // POST /agents/:id/skills-eval
  // ---------------------------------------------------------------------------

  it('returns 200 with with_skills, without_skills, fixture.id on the happy path', async () => {
    const plainApp = await makePlainApp();
    const agentId = await seedAgentWithSkill(plainApp);
    await plainApp.close();

    const app = await makeMockApp();
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills-eval`,
      payload: { fixture_id: 'test-only-happy-path' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fixture.id).toBe('test-only-happy-path');
    expect(body.with_skills).toBeDefined();
    expect(body.without_skills).toBeDefined();

    // Shape assertions — a regression in findings/tokens would silently pass
    // without these checks.
    expect(Array.isArray(body.with_skills.findings)).toBe(true);
    expect(typeof body.with_skills.tokensIn).toBe('number');
    expect(typeof body.with_skills.tokensOut).toBe('number');
    expect(typeof body.with_skills.grounding).toBe('string');
    expect(Array.isArray(body.without_skills.findings)).toBe(true);
    expect(typeof body.without_skills.tokensIn).toBe('number');

    await app.close();
  });

  it(
    'AC-45: an agent with a non-empty attached_context_paths still completes an eval run ' +
      'with no repo clone resolvable, and specs are omitted from both sides’ prompt assembly',
    async () => {
      const plainApp = await makePlainApp();
      const agentId = await seedAgentWithSkill(plainApp);
      await plainApp.close();

      // Set attached_context_paths directly at the data layer — bypassing the
      // save-time discovery validation (AC-33), which requires a resolvable repo
      // clone. That's orthogonal to what AC-45 guards: an agent whose config
      // ALREADY carries this field must still eval cleanly when the harness's
      // static fixture has no clone to resolve project-context documents
      // against. `evaluateSkillsAB` never wires attached_context_paths into
      // `reviewPullRequest` at all (see server/src/modules/agents/service.ts),
      // so this must pass without any repo/context resolution happening.
      await pg.handle.db
        .update(t.agents)
        .set({ attachedContextPaths: ['specs/some-invariant.md'] })
        .where(eq(t.agents.id, agentId));

      const mockAnthropicLlm = new MockLLMProvider('anthropic', { structured: REVIEW_FIXTURE });
      const mockOpenaiLlm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
      const app = await buildApp({
        config: config(),
        db: pg.handle.db,
        overrides: {
          embedder: new MockEmbedder(),
          llm: { anthropic: mockAnthropicLlm, openai: mockOpenaiLlm },
        },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/skills-eval`,
        payload: { fixture_id: 'test-only-happy-path' },
      });

      // No exception thrown, normal 200 + SkillsEvalResult shape — the absent
      // repo clone must not fail the run.
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.fixture.id).toBe('test-only-happy-path');
      expect(Array.isArray(body.with_skills.findings)).toBe(true);
      expect(Array.isArray(body.without_skills.findings)).toBe(true);

      // The agent (provider 'openai') is the one actually invoked; assert every
      // completed LLM call's assembled prompt has NO "## Project context"
      // section — i.e. specs were never injected on either side.
      expect(mockOpenaiLlm.calls.length).toBeGreaterThan(0);
      for (const call of mockOpenaiLlm.calls) {
        const req = call.req as { messages?: { content: string }[] };
        for (const message of req.messages ?? []) {
          expect(message.content).not.toContain('## Project context');
        }
      }
      // The other provider was never invoked for this agent.
      expect(mockAnthropicLlm.calls.length).toBe(0);

      await app.close();
    },
  );

  it('returns 404 on unknown agent id', async () => {
    const app = await makePlainApp();
    const res = await app.inject({
      method: 'POST',
      url: '/agents/00000000-0000-0000-0000-000000000000/skills-eval',
      payload: { fixture_id: 'test-only-happy-path' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 on cross-workspace agent', async () => {
    const otherWsAgentId = await seedAgentInOtherWorkspace();
    const app = await makePlainApp();
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${otherWsAgentId}/skills-eval`,
      payload: { fixture_id: 'test-only-happy-path' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 on unknown fixture id', async () => {
    const plainApp = await makePlainApp();
    const agentId = await seedAgentWithSkill(plainApp);
    await plainApp.close();

    const app = await makeMockApp();
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills-eval`,
      payload: { fixture_id: 'no-such-fixture' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 422 on malformed body (missing fixture_id)', async () => {
    const plainApp = await makePlainApp();
    const agentId = await seedAgentWithSkill(plainApp);
    await plainApp.close();

    const app = await makePlainApp();
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills-eval`,
      payload: { wrong_key: 'x' },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('does not mutate agentSkills rows during an eval run (DB unchanged)', async () => {
    const plainApp = await makePlainApp();
    const agentId = await seedAgentWithSkill(plainApp);
    await plainApp.close();

    // Snapshot before
    const before = await pg.handle.db.select().from(t.agentSkills);

    const app = await makeMockApp();
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills-eval`,
      payload: { fixture_id: 'test-only-happy-path' },
    });
    expect(res.statusCode).toBe(200);

    // Snapshot after — must be identical (deep equal)
    const after = await pg.handle.db.select().from(t.agentSkills);
    expect(after).toEqual(before);

    await app.close();
  });

  // ---------------------------------------------------------------------------
  // GET /agents/eval-fixtures
  // ---------------------------------------------------------------------------

  it('returns both fixtures sorted by id', async () => {
    const app = await makePlainApp();
    const res = await app.inject({ method: 'GET', url: '/agents/eval-fixtures' });
    expect(res.statusCode).toBe(200);
    const fixtures = res.json() as Array<{ id: string }>;
    expect(fixtures.map((f) => f.id)).toEqual(['api-contract-change', 'test-only-happy-path']);
    await app.close();
  });
});

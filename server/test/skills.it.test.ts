import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';
import { AgentsRepository } from '../src/modules/agents/repository.js';

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
});

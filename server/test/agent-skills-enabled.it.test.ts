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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import { AgentsRepository } from '../src/modules/agents/repository.js';
import * as t from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[skills-loader] Docker not available — skipping.');
}

d('skills loader', () => {
  let pg: PgFixture;
  let workspaceId: string;

  beforeAll(async () => {
    pg = await startPg();
    const ids = await seed(pg.handle.db);
    workspaceId = ids.workspaceId;
  });

  afterAll(async () => {
    await pg?.stop();
  });

  it('returns enabled skill bodies in order; skips disabled and empty bodies', async () => {
    const db = pg.handle.db;
    const repo = new AgentsRepository(db);
    const agentId = await seedTestAgentWithSkills(db, workspaceId, [
      { body: 'A', order: 0, enabled: true },
      { body: 'B', order: 1, enabled: false },
      { body: 'C', order: 2, enabled: true },
      { body: '', order: 3, enabled: true },
    ]);

    const bodies = await repo.enabledSkillBodiesForAgent(agentId);

    expect(bodies).toEqual(['A', 'C']);
  });
});

/**
 * Insert a minimal agent + N skills + N link rows. Returns the agent id.
 * Raw DB inserts are used to keep the test self-contained (no HTTP app required).
 */
async function seedTestAgentWithSkills(
  db: Db,
  workspaceId: string,
  skills: Array<{ body: string; order: number; enabled: boolean }>,
): Promise<string> {
  // Insert a minimal agent row.
  const [agent] = await db
    .insert(t.agents)
    .values({
      workspaceId,
      name: `loader-test-agent-${Date.now()}-${Math.random()}`,
      provider: 'openai',
      model: 'gpt-4o-mini',
      systemPrompt: 'test',
      version: 1,
    })
    .returning({ id: t.agents.id });

  const agentId = agent!.id;

  // Insert one skill per entry and link it.
  for (const s of skills) {
    const [skill] = await db
      .insert(t.skills)
      .values({
        workspaceId,
        name: `loader-skill-${Date.now()}-${Math.random()}`,
        description: '',
        type: 'rubric',
        source: 'manual',
        body: s.body,
        enabled: true,
      })
      .returning({ id: t.skills.id });

    await db.insert(t.agentSkills).values({
      agentId,
      skillId: skill!.id,
      order: s.order,
      enabled: s.enabled,
    });
  }

  return agentId;
}

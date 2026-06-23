import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { seed } from '../src/db/seed.js';
import { seedWithSkills } from '../src/db/seed-skills.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[seed-skills] Docker not available — skipping integration tests.');
}

d('seed --with-skills', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  it('default seed leaves the Test Quality agent + new skills absent', async () => {
    const { db } = pg.handle;
    await seed(db);
    const skills = await db.select().from(t.skills);
    expect(skills.find((s) => s.name === 'Test Coverage Nudge')).toBeUndefined();
    const agents = await db.select().from(t.agents);
    expect(agents.find((a) => a.name === 'Test Quality Reviewer')).toBeUndefined();
  });

  it('seedWithSkills creates the agent + both skills, links both', async () => {
    const { db } = pg.handle;
    const { workspaceId, userId } = await seed(db);
    await seedWithSkills(db, workspaceId, userId);

    const skills = await db.select().from(t.skills);
    expect(skills.find((s) => s.name === 'Test Coverage Nudge')).toBeDefined();
    expect(skills.find((s) => s.name === 'API Contract Gate')).toBeDefined();

    const agent = (
      await db.select().from(t.agents).where(eq(t.agents.name, 'Test Quality Reviewer'))
    )[0];
    expect(agent).toBeDefined();

    const links = await db
      .select()
      .from(t.agentSkills)
      .where(eq(t.agentSkills.agentId, agent!.id));
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.enabled === true)).toBe(true);
    const sorted = [...links].sort((a, b) => a.order - b.order);
    expect(sorted.map((l) => l.order)).toEqual([0, 1]);
  });

  it('seedWithSkills is idempotent', async () => {
    const { db } = pg.handle;
    const { workspaceId, userId } = await seed(db);
    await seedWithSkills(db, workspaceId, userId);
    await seedWithSkills(db, workspaceId, userId);

    const skills = await db.select().from(t.skills);
    const agents = await db
      .select()
      .from(t.agents)
      .where(eq(t.agents.name, 'Test Quality Reviewer'));
    const links = await db
      .select()
      .from(t.agentSkills)
      .where(eq(t.agentSkills.agentId, agents[0]!.id));

    // Exactly one of each — no duplicates.
    expect(agents).toHaveLength(1);
    expect(skills.filter((s) => s.name === 'Test Coverage Nudge')).toHaveLength(1);
    expect(skills.filter((s) => s.name === 'API Contract Gate')).toHaveLength(1);
    expect(links).toHaveLength(2);
  });

  it('re-running --with-skills preserves a user-toggled-off link', async () => {
    const { db } = pg.handle;
    const { workspaceId, userId } = await seed(db);
    await seedWithSkills(db, workspaceId, userId);
    const [agent] = await db.select().from(t.agents).where(eq(t.agents.name, 'Test Quality Reviewer'));
    // Simulate UI toggle: disable all links.
    await db.update(t.agentSkills)
      .set({ enabled: false })
      .where(eq(t.agentSkills.agentId, agent!.id));
    // Re-seed.
    await seedWithSkills(db, workspaceId, userId);
    // The disabled state must survive (onConflictDoNothing preserves existing rows).
    const links = await db.select().from(t.agentSkills).where(eq(t.agentSkills.agentId, agent!.id));
    expect(links.every((l) => l.enabled === false)).toBe(true);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from '../../../test/helpers/pg.js';
import { seed } from '../../db/seed.js';
import * as t from '../../db/schema.js';
import { ConventionsRepository, type InsertConvention } from './repository.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[conventions] Docker not available — skipping integration tests.');
}

d('ConventionsRepository', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
  });

  afterAll(async () => {
    await pg?.stop();
  });

  let repo: ConventionsRepository;
  let workspaceId: string;
  let repoId: string;

  const baseRow: Omit<InsertConvention, 'workspaceId' | 'repoId'> = {
    category: 'async-style',
    rule: 'Always use async/await instead of .then() chains.',
    evidencePath: 'src/api/users.ts',
    evidenceSnippet: 'const user = await db.users.find(id);',
    evidenceStartLine: 12,
    evidenceEndLine: 12,
    confidence: 0.91,
  };

  beforeEach(async () => {
    const { db } = pg.handle;
    // Clean conventions table between tests so each test is isolated
    await db.delete(t.conventions);

    const seeded = await seed(db);
    workspaceId = seeded.workspaceId;

    // Insert a fresh test repo for this test run
    const [testRepo] = await db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'test',
        name: `repo-${Date.now()}`,
        fullName: `test/repo-${Date.now()}`,
      })
      .returning();
    repoId = testRepo!.id;

    repo = new ConventionsRepository(db);
  });

  it('inserts and lists conventions for a repo', async () => {
    await repo.insertMany([{ ...baseRow, workspaceId, repoId }]);
    const { candidates, scannedAt } = await repo.listByRepo(workspaceId, repoId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.category).toBe('async-style');
    expect(candidates[0]!.accepted).toBe(false);
    expect(scannedAt).not.toBeNull();
  });

  it('filters by accepted=true', async () => {
    const [ins] = await repo.insertMany([{ ...baseRow, workspaceId, repoId }]);
    await repo.update(workspaceId, ins!.id, { accepted: true });
    const { candidates: accepted } = await repo.listByRepo(workspaceId, repoId, { accepted: true });
    const { candidates: pending } = await repo.listByRepo(workspaceId, repoId, { accepted: false });
    expect(accepted).toHaveLength(1);
    expect(pending).toHaveLength(0);
  });

  it('deleteByRepo removes all candidates for that repo', async () => {
    await repo.insertMany([{ ...baseRow, workspaceId, repoId }]);
    await repo.deleteByRepo(workspaceId, repoId);
    const { candidates } = await repo.listByRepo(workspaceId, repoId);
    expect(candidates).toHaveLength(0);
  });

  it('update patches rule and accepted', async () => {
    const [ins] = await repo.insertMany([{ ...baseRow, workspaceId, repoId }]);
    const updated = await repo.update(workspaceId, ins!.id, { rule: 'Updated rule', accepted: true });
    expect(updated?.rule).toBe('Updated rule');
    expect(updated?.accepted).toBe(true);
  });

  it('update returns undefined for unknown id', async () => {
    const result = await repo.update(workspaceId, '00000000-0000-0000-0000-000000000000', { accepted: true });
    expect(result).toBeUndefined();
  });
});

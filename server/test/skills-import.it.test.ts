import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockGitClient, MockGitHubClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

function buildMultipart(filename: string, content: string, fieldName = 'file'): { headers: Record<string, string>; payload: Buffer } {
  const boundary = '----DevDigestTestBoundary';
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: text/markdown\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(content, 'utf8'), Buffer.from(tail, 'utf8')]),
  };
}

d('skills import module', () => {
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

  async function skillCount() {
    const [{ c }] = await pg.handle.db.execute<{ c: string }>(sql`SELECT COUNT(*)::text AS c FROM ${t.skills}`);
    return Number(c);
  }

  it('parses a valid .md file and does not create a skill row', async () => {
    const app = await makeApp();
    const before = await skillCount();
    const { headers, payload } = buildMultipart('my-skill.md', '---\nname: foo\ntype: security\n---\n# Foo\n\nWhat it does.');
    const res = await app.inject({ method: 'POST', url: '/skills/import/preview', headers, payload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe('foo');
    expect(body.type).toBe('security');
    expect(body.body).toContain('# Foo');
    expect(body.warnings).toEqual([]);
    expect(await skillCount()).toBe(before);
    await app.close();
  });

  it('rejects non-.md filename with 422', async () => {
    const app = await makeApp();
    const { headers, payload } = buildMultipart('not-markdown.txt', '# x\n\nbody');
    const res = await app.inject({ method: 'POST', url: '/skills/import/preview', headers, payload });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('validation_error');
    await app.close();
  });

  it('rejects empty body with 422', async () => {
    const app = await makeApp();
    const { headers, payload } = buildMultipart('empty.md', '---\nname: x\n---\n');
    const res = await app.inject({ method: 'POST', url: '/skills/import/preview', headers, payload });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('emits a warning when frontmatter type is invalid', async () => {
    const app = await makeApp();
    const { headers, payload } = buildMultipart('bad-type.md', '---\nname: x\ntype: bogus\n---\nBody text.');
    const res = await app.inject({ method: 'POST', url: '/skills/import/preview', headers, payload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe('custom');
    expect(body.warnings.some((w: string) => w.includes('bogus'))).toBe(true);
    await app.close();
  });

  it('rejects payload larger than 256KB without writing a row', async () => {
    const app = await makeApp();
    const before = await skillCount();
    const huge = '# Title\n\n' + 'x'.repeat(260 * 1024);
    const { headers, payload } = buildMultipart('huge.md', huge);
    const res = await app.inject({ method: 'POST', url: '/skills/import/preview', headers, payload });
    expect([413, 422]).toContain(res.statusCode);
    expect(await skillCount()).toBe(before);
    await app.close();
  });

  it('rejects multipart with no file field with 422', async () => {
    const app = await makeApp();
    const boundary = '----DevDigestTestBoundary';
    const payload = Buffer.from(`--${boundary}--\r\n`, 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/skills/import/preview',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

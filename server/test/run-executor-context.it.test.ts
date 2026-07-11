/**
 * Integration coverage for L05 T4 — `buildSpecsDigest` in the production
 * review path (`run-executor.ts`): the effective attached-document set
 * (agent-first, enabled-skill order, dedupe first-wins), the fail-closed
 * pre-flight (re-verified fresh every run against `container.context.listPaths`),
 * and the `specs_read` / `specs_tokens` trace fields.
 *
 * `MockGitClient` is intentionally NOT used — the pre-flight calls
 * `container.context.listPaths`, which needs a REAL clone directory to glob
 * against (see `context-reader.it.test.ts`'s docstring for why). This file
 * reuses the same `RealDirGitClient` pattern as `context-reader.it.test.ts` /
 * `agents-context-paths.it.test.ts`, anchoring the clone root under
 * `config.cloneDir` (`DEVDIGEST_CLONE_DIR`). For the LLM, this file reuses the
 * `MockLLMProvider` call-count-inspection pattern from
 * `run-executor-skills.it.test.ts` (Spec D).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  GitClient,
  RepoRef,
  CloneOptions,
  UnifiedDiff,
  BlameLine,
  GitCommit,
  Review,
  RunTrace,
} from '@devdigest/shared';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { waitForPrRuns } from './helpers/runs.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockLLMProvider } from '../src/adapters/mocks.js';
import { AgentsRepository } from '../src/modules/agents/repository.js';
import * as t from '../src/db/schema.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[run-executor-context] Docker not available — skipping.');
}

/** A minimal Review fixture accepted by the Review Zod schema. */
const REVIEW_FIXTURE: Review = {
  verdict: 'approve',
  summary: 'LGTM',
  score: 90,
  findings: [],
};

/**
 * GitClient-shaped test double over a REAL directory on disk (mirrors
 * `context-reader.it.test.ts`). `diff()` intentionally returns an empty
 * result so `loadDiff` falls back to reconstructing the diff from the
 * seeded `pr_files` patches — exactly like the other integration tests in
 * this suite that don't need a real `git diff`.
 */
class RealDirGitClient implements GitClient {
  public reads: string[] = [];
  constructor(protected root: string) {}
  clonePathFor(_repo: RepoRef): string {
    return this.root;
  }
  async clone(_repo: RepoRef, _url: string, _opts?: CloneOptions): Promise<{ path: string }> {
    return { path: this.root };
  }
  async fetchPullHead(): Promise<void> {}
  async sync(): Promise<{ head: string }> {
    return { head: 'HEAD' };
  }
  async currentHead(): Promise<string> {
    return 'HEAD';
  }
  async diff(): Promise<UnifiedDiff> {
    return { raw: '', files: [] };
  }
  async diffNameOnly(): Promise<string[]> {
    return [];
  }
  async blame(): Promise<BlameLine[]> {
    return [];
  }
  async log(): Promise<GitCommit[]> {
    return [];
  }
  async readFile(_repo: RepoRef, path: string): Promise<string> {
    this.reads.push(path);
    return readFile(join(this.root, path), 'utf8');
  }
}

/**
 * Simulates a TOCTOU race distinct from "deleted before the run" (AC-31): the
 * target path is present on disk (and therefore passes the fresh pre-flight
 * `listPaths()` whitelist), but its `readFile` throws a RAW Node fs-shaped
 * error — as if the file vanished between the pre-flight check and this
 * specific read (e.g. a concurrent `resync`'s `git reset --hard` on the same
 * clone). Mirrors the exact race T1's `ContextService.readOne` already
 * guards against; the error's `.message` deliberately embeds the ABSOLUTE
 * clone path, exactly like a real `ENOENT` would, so the test can assert the
 * production code never lets that leak into the trace log.
 */
class MidLoopVanishGitClient extends RealDirGitClient {
  constructor(
    root: string,
    private vanishingPath: string,
  ) {
    super(root);
  }
  async readFile(repo: RepoRef, path: string): Promise<string> {
    if (path === this.vanishingPath) {
      this.reads.push(path);
      throw new Error(`ENOENT: no such file or directory, open '${join(this.root, path)}'`);
    }
    return super.readFile(repo, path);
  }
}

d('run-executor: buildSpecsDigest — Project Context injection (L05 T4)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });

  afterAll(async () => {
    await pg?.stop();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function insertRepo(name: string): Promise<string> {
    const [row] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
      .returning();
    return row!.id;
  }

  let prSeq = 0;
  async function seedPr(repoId: string) {
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 200 + prSeq++,
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
    await pg.handle.db.insert(t.prFiles).values({
      prId: pr!.id,
      path: 'src/config.ts',
      additions: 1,
      deletions: 0,
      patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  timeout: 5000,\n   redisUrl: x,',
    });
    return pr!;
  }

  function makeApp(git: GitClient, mockLlm: MockLLMProvider) {
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      // Anchor the RealDirGitClient's fixed root under config.cloneDir — the
      // reader's defense-in-depth "resolved root must live under cloneDir"
      // check would otherwise (wrongly) treat every fixture as not-cloned.
      DEVDIGEST_CLONE_DIR: tmpdir(),
    } as NodeJS.ProcessEnv;
    const config = loadConfig(env);
    return buildApp({ config, db: pg.handle.db, overrides: { git, llm: { openai: mockLlm } } });
  }

  async function createAgent(app: Awaited<ReturnType<typeof makeApp>>): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: `context-agent-${Date.now()}-${Math.random()}`,
        provider: 'openai',
        model: 'gpt-4o-mini',
        system_prompt: 'review the diff',
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function createSkill(
    app: Awaited<ReturnType<typeof makeApp>>,
    name: string,
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: { name, type: 'rubric', body: `${name} body` },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  /** Attach paths to an agent through the real PUT (exercises save-time validation too). */
  async function attachAgentPaths(
    app: Awaited<ReturnType<typeof makeApp>>,
    agentId: string,
    paths: string[],
    repoId: string,
  ) {
    const res = await app.inject({
      method: 'PUT',
      url: `/agents/${agentId}`,
      payload: { attached_context_paths: paths, repo_id: repoId },
    });
    expect(res.statusCode).toBe(200);
  }

  /** Attach paths to a skill through the real PUT. */
  async function attachSkillPaths(
    app: Awaited<ReturnType<typeof makeApp>>,
    skillId: string,
    paths: string[],
    repoId: string,
  ) {
    const res = await app.inject({
      method: 'PUT',
      url: `/skills/${skillId}`,
      payload: { attached_context_paths: paths, repo_id: repoId },
    });
    expect(res.statusCode).toBe(200);
  }

  /** Trigger a review run and wait for it to reach a terminal status. */
  async function runReview(
    app: Awaited<ReturnType<typeof makeApp>>,
    prId: string,
    agentId: string,
  ): Promise<Array<typeof t.agentRuns.$inferSelect>> {
    const res = await app.inject({
      method: 'POST',
      url: `/pulls/${prId}/review`,
      payload: { agentId },
    });
    expect(res.statusCode).toBe(200);
    return waitForPrRuns(pg.handle.db, prId, { expected: 1 });
  }

  async function getTrace(
    app: Awaited<ReturnType<typeof makeApp>>,
    runId: string,
  ): Promise<RunTrace> {
    const res = await app.inject({ method: 'GET', url: `/runs/${runId}/trace` });
    expect(res.statusCode).toBe(200);
    return res.json() as RunTrace;
  }

  it('null, absent, and empty attached_context_paths all produce an identical run outcome (AC-14)', async () => {
    const root = await tempDir('ctx-exec-ac14-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'unused.md'), '# unused');

    const mockLlm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
    const app = await makeApp(new RealDirGitClient(root), mockLlm);
    const repoId = await insertRepo('ac14-repo');

    // Agent A: never touches attached_context_paths — stays `null` in storage.
    const agentNull = await createAgent(app);
    const prNull = await seedPr(repoId);
    const runsNull = await runReview(app, prNull.id, agentNull);
    expect(runsNull[0]!.status).toBe('done');
    const traceNull = await getTrace(app, runsNull[0]!.id);
    expect(traceNull.specs_read).toEqual([]);
    expect(traceNull.prompt_assembly.specs ?? null).toBeNull();

    // Agent B: explicitly saved with an empty array.
    const agentEmpty = await createAgent(app);
    await attachAgentPaths(app, agentEmpty, [], repoId);
    const prEmpty = await seedPr(repoId);
    const runsEmpty = await runReview(app, prEmpty.id, agentEmpty);
    expect(runsEmpty[0]!.status).toBe('done');
    const traceEmpty = await getTrace(app, runsEmpty[0]!.id);
    expect(traceEmpty.specs_read).toEqual([]);
    expect(traceEmpty.prompt_assembly.specs ?? null).toBeNull();

    // Identical outcome: same specs_read, same "no Project context" prompt shape.
    expect(traceEmpty.specs_read).toEqual(traceNull.specs_read);
    expect(traceEmpty.prompt_assembly.specs).toEqual(traceNull.prompt_assembly.specs);

    await app.close();
  });

  it('effective-set merge: agent-first order, skill order, dedupe keeps first occurrence (AC-18, AC-25)', async () => {
    const root = await tempDir('ctx-exec-ac18-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'a.md'), '# spec A content');
    await writeFile(join(root, 'specs', 'b.md'), '# spec B content');
    await writeFile(join(root, 'specs', 'c.md'), '# spec C content');

    const mockLlm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
    const app = await makeApp(new RealDirGitClient(root), mockLlm);
    const repoId = await insertRepo('ac18-repo');

    const agentId = await createAgent(app);
    // Agent's own order: b then a. 'a' also appears in the skill's list below —
    // the agent's earlier occurrence must win (dedupe, first-wins).
    await attachAgentPaths(app, agentId, ['specs/b.md', 'specs/a.md'], repoId);

    const skillId = await createSkill(app, `skill-ac18-${Date.now()}`);
    await attachSkillPaths(app, skillId, ['specs/a.md', 'specs/c.md'], repoId);

    const agentsRepo = new AgentsRepository(pg.handle.db);
    await agentsRepo.linkSkill(agentId, skillId, 0, true);

    const pr = await seedPr(repoId);
    const runs = await runReview(app, pr.id, agentId);
    expect(runs[0]!.status).toBe('done');

    const trace = await getTrace(app, runs[0]!.id);
    // Effective order: agent's own list (b, a) first, then skill's list minus
    // the already-seen 'a' (c only).
    expect(trace.specs_read).toEqual(['specs/b.md', 'specs/a.md', 'specs/c.md']);

    // AC-26: per-document token count, length-aligned with specs_read.
    expect(trace.specs_tokens).toHaveLength(trace.specs_read.length);
    expect(trace.specs_tokens!.every((n) => typeof n === 'number' && n > 0)).toBe(true);

    // AC-23: the content actually reached assemblePrompt's "## Project context".
    expect(trace.prompt_assembly.specs).toContain('spec B content');
    expect(trace.prompt_assembly.specs).toContain('spec A content');
    expect(trace.prompt_assembly.specs).toContain('spec C content');
    expect(trace.prompt_assembly.user).toContain('## Project context');

    await app.close();
  });

  it("disabled skill's attached docs excluded from the effective set (AC-19)", async () => {
    const root = await tempDir('ctx-exec-ac19-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'enabled.md'), '# enabled skill doc');
    await writeFile(join(root, 'specs', 'disabled.md'), '# disabled skill doc');

    const mockLlm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
    const app = await makeApp(new RealDirGitClient(root), mockLlm);
    const repoId = await insertRepo('ac19-repo');

    const agentId = await createAgent(app);

    const skillEnabled = await createSkill(app, `skill-enabled-${Date.now()}`);
    await attachSkillPaths(app, skillEnabled, ['specs/enabled.md'], repoId);
    const skillDisabled = await createSkill(app, `skill-disabled-${Date.now()}`);
    await attachSkillPaths(app, skillDisabled, ['specs/disabled.md'], repoId);

    const agentsRepo = new AgentsRepository(pg.handle.db);
    await agentsRepo.linkSkill(agentId, skillEnabled, 0, true);
    await agentsRepo.linkSkill(agentId, skillDisabled, 1, false);

    const pr = await seedPr(repoId);
    const runs = await runReview(app, pr.id, agentId);
    expect(runs[0]!.status).toBe('done');

    const trace = await getTrace(app, runs[0]!.id);
    expect(trace.specs_read).toEqual(['specs/enabled.md']);
    expect(trace.prompt_assembly.specs).toContain('enabled skill doc');
    expect(trace.prompt_assembly.specs).not.toContain('disabled skill doc');

    await app.close();
  });

  it('pre-flight validates every effective path before any LLM call, and fails the run on a traversal path (AC-22, AC-29, AC-30, AC-33, AC-34)', async () => {
    const root = await tempDir('ctx-exec-ac30-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'a.md'), '# a');

    const mockLlm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
    const git = new RealDirGitClient(root);
    const app = await makeApp(git, mockLlm);
    const repoId = await insertRepo('ac30-repo');

    const agentId = await createAgent(app);
    // A `../` traversal path could never pass save-time validation (AC-12/34)
    // — it would never appear in a real discovery set. To exercise the
    // RUN-TIME pre-flight specifically (defense in depth: never trust storage
    // alone, AC-33), write the malicious path directly via the repository,
    // bypassing the HTTP save-time gate, simulating stale/bypassed data.
    const agentsRepo = new AgentsRepository(pg.handle.db);
    await agentsRepo.update(workspaceId, agentId, {
      attachedContextPaths: ['../../.devdigest/secrets.json'],
    });

    const pr = await seedPr(repoId);
    const runs = await runReview(app, pr.id, agentId);
    expect(runs[0]!.status).toBe('failed');

    // AC-22/AC-29/AC-30: zero LLM calls — pre-flight must fail BEFORE any
    // prompt is assembled or LLM invoked.
    expect(mockLlm.calls).toHaveLength(0);
    // AC-34: the traversal target is never read.
    expect(git.reads).not.toContain('../../.devdigest/secrets.json');
    expect(git.reads).toHaveLength(0);

    // AC-32: the failure (naming the offending path) is visible in the persisted trace log.
    const trace = await getTrace(app, runs[0]!.id);
    const logText = trace.log.map((l) => l.msg).join('\n');
    expect(logText).toContain('../../.devdigest/secrets.json');
    expect(trace.specs_read).toEqual([]);

    await app.close();
  });

  it('pre-flight fails the run on a renamed or deleted file (AC-31, AC-32, AC-33)', async () => {
    const root = await tempDir('ctx-exec-ac31-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'temp.md'), '# will be removed');

    const mockLlm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
    const git = new RealDirGitClient(root);
    const app = await makeApp(git, mockLlm);
    const repoId = await insertRepo('ac31-repo');

    const agentId = await createAgent(app);
    // Valid at attach time (passes save-time validation).
    await attachAgentPaths(app, agentId, ['specs/temp.md'], repoId);

    // Removed from the repo BEFORE the run — a fresh discovery pass at run
    // time must no longer contain it (AC-33: never trusted from storage).
    await unlink(join(root, 'specs', 'temp.md'));

    const pr = await seedPr(repoId);
    const runs = await runReview(app, pr.id, agentId);
    expect(runs[0]!.status).toBe('failed');
    expect(mockLlm.calls).toHaveLength(0);
    expect(git.reads).toHaveLength(0);

    const trace = await getTrace(app, runs[0]!.id);
    const logText = trace.log.map((l) => l.msg).join('\n');
    expect(logText).toContain('specs/temp.md');
    expect(trace.specs_read).toEqual([]);

    await app.close();
  });

  it('a document that vanishes mid-loop (TOCTOU, AFTER passing pre-flight) fails cleanly — no absolute clone path or raw fs error leaks into the trace log', async () => {
    const root = await tempDir('ctx-exec-toctou-');
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 'a.md'), '# a content');
    await writeFile(join(root, 'specs', 'b.md'), '# b content — vanishes mid-read');

    const mockLlm = new MockLLMProvider('openai', { structured: REVIEW_FIXTURE });
    // Both files exist on disk — BOTH pass the fresh pre-flight whitelist.
    // This is NOT the "deleted before the run" case (AC-31, tested above):
    // 'specs/b.md' only fails when its own turn in the READ loop comes,
    // AFTER pre-flight already validated the whole effective set.
    const git = new MidLoopVanishGitClient(root, 'specs/b.md');
    const app = await makeApp(git, mockLlm);
    const repoId = await insertRepo('toctou-repo');

    const agentId = await createAgent(app);
    await attachAgentPaths(app, agentId, ['specs/a.md', 'specs/b.md'], repoId);

    const pr = await seedPr(repoId);
    const runs = await runReview(app, pr.id, agentId);
    expect(runs[0]!.status).toBe('failed');

    // The digest never completes (b.md's read throws mid-loop), so
    // reviewPullRequest — and therefore the LLM — is never reached.
    expect(mockLlm.calls).toHaveLength(0);

    const trace = await getTrace(app, runs[0]!.id);
    const logText = trace.log.map((l) => l.msg).join('\n');
    // Clean, path-only message naming the vanished document...
    expect(logText).toContain('specs/b.md');
    expect(logText).toContain('vanished during read');
    // ...and NEVER the underlying raw fs error message or the absolute clone
    // path it embeds (the security-critical assertion for this test).
    expect(logText.toUpperCase()).not.toContain('ENOENT');
    expect(logText).not.toContain(root);
    // Same guarantee holds for the run's persisted top-level error field.
    expect(runs[0]!.error ?? '').not.toContain(root);
    expect((runs[0]!.error ?? '').toUpperCase()).not.toContain('ENOENT');
    // The digest never returned, so nothing was recorded as read.
    expect(trace.specs_read).toEqual([]);

    await app.close();
  });
});

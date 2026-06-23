import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractConventions } from './extractor.js';
import type { Container } from '../../platform/container.js';

// Mock the prompt loader so tests don't need the file on disk
vi.mock('../../platform/prompts.js', () => ({
  loadPromptTemplate: vi.fn().mockResolvedValue('You are a coding convention detector.'),
}));

// Mock feature-models so tests don't need a DB
vi.mock('../settings/feature-models.js', () => ({
  resolveFeatureModel: vi
    .fn()
    .mockResolvedValue({ provider: 'openai', model: 'gpt-4o' }),
}));

const mockEmit = vi.fn();

const SAMPLE_CONTENT = `const result = await db.users.find(id);
const posts = await db.posts.findMany({ userId });`;

function makeContainer(candidates: unknown[] = []): Partial<Container> {
  return {
    repoIntel: {
      getConventionSamples: vi.fn().mockResolvedValue(['src/api/users.ts']),
    } as unknown as Container['repoIntel'],
    git: {
      // GitClient.readFile signature: readFile(repo: RepoRef, path: string): Promise<string>
      readFile: vi.fn().mockResolvedValue(SAMPLE_CONTENT),
    } as unknown as Container['git'],
    llm: vi.fn().mockResolvedValue({
      completeStructured: vi.fn().mockResolvedValue({
        data: { candidates },
      }),
    }),
  };
}

describe('extractConventions', () => {
  beforeEach(() => mockEmit.mockClear());

  it('returns verified candidates whose snippet appears in sampled content', async () => {
    const container = makeContainer([
      {
        category: 'async-style',
        rule: 'Use async/await instead of .then()',
        evidence_path: 'src/api/users.ts',
        evidence_snippet: 'const result = await db.users.find(id);',
        confidence: 0.91,
      },
    ]);

    const result = await extractConventions(
      container as unknown as Container,
      'ws-1',
      'repo-1',
      { owner: 'acme', name: 'api', defaultBranch: 'main' },
      mockEmit,
    );

    expect(result).toHaveLength(1);
    const first = result[0]!;
    expect(first.category).toBe('async-style');
    expect(first.confidence).toBe(0.91);
    expect(mockEmit).toHaveBeenCalledWith('done', expect.any(String), { count: 1 });
  });

  it('discards candidates whose snippet is NOT in the sampled content', async () => {
    const container = makeContainer([
      {
        category: 'naming',
        rule: 'Use camelCase',
        evidence_path: 'src/api/users.ts',
        evidence_snippet: 'this snippet does not appear in the file at all',
        confidence: 0.8,
      },
    ]);
    const result = await extractConventions(
      container as unknown as Container,
      'ws-1',
      'repo-1',
      { owner: 'acme', name: 'api', defaultBranch: 'main' },
      mockEmit,
    );
    expect(result).toHaveLength(0);
  });

  it('discards candidates from a path not in the sampled set', async () => {
    const container = makeContainer([
      {
        category: 'typing',
        rule: 'Annotate return types',
        evidence_path: 'src/not-sampled-file.ts',
        evidence_snippet: 'function foo(): string',
        confidence: 0.85,
      },
    ]);
    const result = await extractConventions(
      container as unknown as Container,
      'ws-1',
      'repo-1',
      { owner: 'acme', name: 'api', defaultBranch: 'main' },
      mockEmit,
    );
    expect(result).toHaveLength(0);
  });

  it('emits sampling, analyzing, verifying, done events', async () => {
    const container = makeContainer([]);
    await extractConventions(
      container as unknown as Container,
      'ws-1',
      'repo-1',
      { owner: 'acme', name: 'api', defaultBranch: 'main' },
      mockEmit,
    );
    const kinds = mockEmit.mock.calls.map((c) => c[0]);
    expect(kinds).toContain('sampling');
    expect(kinds).toContain('analyzing');
    expect(kinds).toContain('done');
  });
});

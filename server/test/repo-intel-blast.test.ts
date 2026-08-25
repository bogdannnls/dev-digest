import { describe, it, expect } from 'vitest';
import { RepoIntelService } from '../src/modules/repo-intel/service.js';
import type {
  FullSymbolRow,
  IndexerFileFactsRow,
  ResolvedCallerRow,
  RepoBasics,
} from '../src/modules/repo-intel/repository.js';
import type { IndexState } from '../src/modules/repo-intel/types.js';

/**
 * R1/R3 — `viaFile` on `BlastCallerRow` (both persistent + degraded/ripgrep paths)
 * and the per-symbol caller cap (replacing the old GLOBAL slice(0, 20)).
 *
 * Pattern mirrors `repo-intel-facade-degraded.test.ts`: the service's `repo`
 * (RepoIntelRepository) is patched directly so we exercise `tryPersistentBlast`
 * and the ripgrep fallback without Postgres or a real clone.
 */

function buildPersistentService(opts: {
  changedFile: string;
  declRows: FullSymbolRow[];
  callerRows: ResolvedCallerRow[];
  callerSymRows: FullSymbolRow[];
  facts?: IndexerFileFactsRow[];
  importers?: Array<{ fromFile: string; toFile: string }>;
}): RepoIntelService {
  const container = {
    config: { repoIntelEnabled: true },
    db: {} as never,
    codeIndex: { symbols: async () => [], references: async () => [] } as never,
  } as never;
  const svc = new RepoIntelService(container);
  const allFacts = opts.facts ?? [];
  (svc as unknown as { repo: Record<string, unknown> }).repo = {
    tryGetIndexState: async () => ({ status: 'full' }) as unknown as IndexState,
    getSymbolRows: async (_repoId: string, paths: string[]) =>
      paths[0] === opts.changedFile ? opts.declRows : opts.callerSymRows,
    getResolvedCallers: async () => opts.callerRows,
    // Filter by requested files so the hop-1 (caller files) and hop-2 (importer
    // files) reads return their own facts from a single keyed list.
    getFileFacts: async (_repoId: string, files: string[]) =>
      allFacts.filter((f) => files.includes(f.filePath)),
    getImporters: async () => opts.importers ?? [],
  };
  return svc;
}

function buildDegradedRipgrepService(opts: {
  basics: RepoBasics;
  symbols: Array<{ path: string; name: string; kind: string; line: number }>;
  referencesByName: Record<string, Array<{ fromPath: string; toSymbol: string; line: number }>>;
}): RepoIntelService {
  const container = {
    config: { repoIntelEnabled: false },
    db: {} as never,
    codeIndex: {
      symbols: async () => opts.symbols,
      references: async (_ref: unknown, name: string) => opts.referencesByName[name] ?? [],
    } as never,
  } as never;
  const svc = new RepoIntelService(container);
  (svc as unknown as { repo: Record<string, unknown> }).repo = {
    getRepoBasics: async () => opts.basics,
  };
  return svc;
}

describe('BlastCallerRow.viaFile — persistent path', () => {
  it('sets viaFile to the resolved caller declFile', async () => {
    const svc = buildPersistentService({
      changedFile: 'src/util/helper.ts',
      declRows: [
        {
          path: 'src/util/helper.ts',
          name: 'formatDate',
          kind: 'function',
          line: 3,
          endLine: 5,
          exported: true,
          signature: null,
        },
      ],
      callerRows: [
        {
          fromPath: 'src/routes/users.ts',
          toSymbol: 'formatDate',
          line: 12,
          rank: 90,
          declFile: 'src/util/helper.ts',
        },
      ],
      callerSymRows: [
        {
          path: 'src/routes/users.ts',
          name: 'listUsers',
          kind: 'function',
          line: 10,
          endLine: 20,
          exported: true,
          signature: null,
        },
      ],
      facts: [],
    });

    const blast = await svc.getBlastRadius('r1', ['src/util/helper.ts']);

    expect(blast.degraded).toBe(false);
    expect(blast.callers).toEqual([
      {
        file: 'src/routes/users.ts',
        symbol: 'listUsers',
        viaSymbol: 'formatDate',
        viaFile: 'src/util/helper.ts',
        line: 12,
        rank: 90,
      },
    ]);
  });
});

describe('BlastCallerRow.viaFile — degraded/ripgrep path', () => {
  it('sets viaFile to the changed symbol declaring file', async () => {
    const svc = buildDegradedRipgrepService({
      basics: { id: 'r1', owner: 'acme', name: 'repo', defaultBranch: 'main', clonePath: '/tmp/nonexistent-clone' },
      symbols: [{ path: 'src/util/helper.ts', name: 'formatDate', kind: 'function', line: 3 }],
      referencesByName: {
        formatDate: [{ fromPath: 'src/routes/users.ts', toSymbol: 'formatDate', line: 12 }],
      },
    });

    const blast = await svc.getBlastRadius('r1', ['src/util/helper.ts']);

    expect(blast.degraded).toBe(true);
    expect(blast.callers).toEqual([
      {
        file: 'src/routes/users.ts',
        symbol: 'users.ts', // no enclosing symbol declared for the caller file → falls back to basename
        viaSymbol: 'formatDate',
        viaFile: 'src/util/helper.ts',
        line: 12,
        rank: 0,
      },
    ]);
  });

  it('two same-named symbols in different files each keep their callers (dup-name regression)', async () => {
    const svc = buildDegradedRipgrepService({
      basics: { id: 'r1', owner: 'acme', name: 'repo', defaultBranch: 'main', clonePath: '/tmp/nonexistent-clone' },
      symbols: [
        { path: 'src/a/util.ts', name: 'run', kind: 'function', line: 1 },
        { path: 'src/b/util.ts', name: 'run', kind: 'function', line: 1 },
      ],
      referencesByName: {
        run: [{ fromPath: 'src/routes/x.ts', toSymbol: 'run', line: 5 }],
      },
    });

    const blast = await svc.getBlastRadius('r1', ['src/a/util.ts', 'src/b/util.ts']);

    expect(blast.degraded).toBe(true);
    // The name-matched caller is attributed to BOTH same-named symbols
    // (recall-over-precision), each with its own viaFile. Pre-fix the second symbol
    // collided on the dedup key (which lacked sym.file) and got ZERO callers.
    expect(blast.callers).toEqual([
      { file: 'src/routes/x.ts', symbol: 'x.ts', viaSymbol: 'run', viaFile: 'src/a/util.ts', line: 5, rank: 0 },
      { file: 'src/routes/x.ts', symbol: 'x.ts', viaSymbol: 'run', viaFile: 'src/b/util.ts', line: 5, rank: 0 },
    ]);
  });
});

describe('R3 — per-symbol caller cap (replaces the global slice)', () => {
  it('persistent path: 25 callers via symbol A + 5 via symbol B → 20 (A) + 5 (B), rank order preserved', async () => {
    const changedFile = 'f.ts';

    const aCallerRows: ResolvedCallerRow[] = Array.from({ length: 25 }, (_, i) => ({
      fromPath: `caller-a-${i}.ts`,
      toSymbol: 'A',
      line: 10,
      rank: 125 - i, // 125 downto 101, all unique + strictly decreasing
      declFile: changedFile,
    }));
    const bCallerRows: ResolvedCallerRow[] = Array.from({ length: 5 }, (_, i) => ({
      fromPath: `caller-b-${i}.ts`,
      toSymbol: 'B',
      line: 10,
      rank: 50 - i, // 50 downto 46
      declFile: changedFile,
    }));
    const callerRows = [...aCallerRows, ...bCallerRows];

    const callerSymRows: FullSymbolRow[] = callerRows.map((c) => ({
      path: c.fromPath,
      name: `enclosing-${c.fromPath}`,
      kind: 'function',
      line: 1,
      endLine: 20,
      exported: true,
      signature: null,
    }));

    const svc = buildPersistentService({
      changedFile,
      declRows: [
        { path: changedFile, name: 'A', kind: 'function', line: 1, endLine: 2, exported: true, signature: null },
        { path: changedFile, name: 'B', kind: 'function', line: 5, endLine: 6, exported: true, signature: null },
      ],
      callerRows,
      callerSymRows,
      facts: [],
    });

    const blast = await svc.getBlastRadius('r1', [changedFile]);

    const aResults = blast.callers.filter((c) => c.viaSymbol === 'A');
    const bResults = blast.callers.filter((c) => c.viaSymbol === 'B');

    expect(aResults).toHaveLength(20);
    expect(bResults).toHaveLength(5);
    expect(blast.callers).toHaveLength(25);

    // Rank order preserved among survivors — the top 20 of A's 25 ranks (125..106),
    // the lowest 5 (105..101) are dropped by the per-symbol cap.
    expect(aResults.map((c) => c.rank)).toEqual(
      Array.from({ length: 20 }, (_, i) => 125 - i),
    );
    expect(bResults.map((c) => c.rank)).toEqual([50, 49, 48, 47, 46]);

    // Global order: all surviving A callers (rank-sorted) precede all B callers,
    // matching the pre-cap sort — the cap only drops rows, never reorders.
    expect(blast.callers.map((c) => c.viaSymbol)).toEqual([
      ...Array(20).fill('A'),
      ...Array(5).fill('B'),
    ]);
    for (const c of blast.callers) expect(c.viaFile).toBe(changedFile);
  });

  it('degraded/ripgrep path: caps callers per symbol (previously unbounded)', async () => {
    const refs = Array.from({ length: 25 }, (_, i) => ({
      fromPath: `caller-${i}.ts`,
      toSymbol: 'formatDate',
      line: 1,
    }));
    const svc = buildDegradedRipgrepService({
      basics: { id: 'r1', owner: 'acme', name: 'repo', defaultBranch: 'main', clonePath: '/tmp/nonexistent-clone' },
      symbols: [{ path: 'src/util/helper.ts', name: 'formatDate', kind: 'function', line: 3 }],
      referencesByName: { formatDate: refs },
    });

    const blast = await svc.getBlastRadius('r1', ['src/util/helper.ts']);

    expect(blast.callers).toHaveLength(20);
  });
});

describe('R4 — transitive 2-hop endpoint reachability (persistent path)', () => {
  it("attributes a hop-2 file's endpoints to the hop-1 caller it routes through, excluding the changed file", async () => {
    const svc = buildPersistentService({
      changedFile: 'src/util/helper.ts',
      declRows: [
        {
          path: 'src/util/helper.ts',
          name: 'formatDate',
          kind: 'function',
          line: 3,
          endLine: 5,
          exported: true,
          signature: null,
        },
      ],
      // hop-1: a service file imports the changed helper — a caller with no endpoints of its own.
      callerRows: [
        {
          fromPath: 'src/service/user-service.ts',
          toSymbol: 'formatDate',
          line: 10,
          rank: 50,
          declFile: 'src/util/helper.ts',
        },
      ],
      callerSymRows: [
        {
          path: 'src/service/user-service.ts',
          name: 'getUser',
          kind: 'function',
          line: 8,
          endLine: 20,
          exported: true,
          signature: null,
        },
      ],
      facts: [
        { filePath: 'src/service/user-service.ts', endpoints: [], crons: [] }, // hop-1: no endpoints
        { filePath: 'src/routes/users.ts', endpoints: ['GET /users'], crons: [] }, // hop-2: the reachable route
        { filePath: 'src/util/helper.ts', endpoints: ['GET /changed-file'], crons: [] }, // changed file — must be excluded
      ],
      importers: [
        { fromFile: 'src/routes/users.ts', toFile: 'src/service/user-service.ts' }, // hop-2 → hop-1
        { fromFile: 'src/util/helper.ts', toFile: 'src/service/user-service.ts' }, // changed file → excluded from hop-2
      ],
    });

    const blast = await svc.getBlastRadius('r1', ['src/util/helper.ts']);

    expect(blast.degraded).toBe(false);
    expect(blast.impactedEndpoints).toContain('GET /users');
    // The changed file is never treated as a hop-2 source (no self/loop attribution).
    expect(blast.impactedEndpoints).not.toContain('GET /changed-file');
    expect(blast.secondHopEndpointsByCallerFile).toEqual({
      'src/service/user-service.ts': ['GET /users'],
    });
  });
});

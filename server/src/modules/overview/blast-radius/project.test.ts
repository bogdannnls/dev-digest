import { describe, expect, it } from 'vitest';
import type { BlastResult } from '../../repo-intel/types.js';
import { projectBlastRadius } from './project.js';

describe('projectBlastRadius', () => {
  it('regroups callers under the changed symbol they reach and attributes per-symbol facts', () => {
    const input: BlastResult = {
      changedSymbols: [
        { file: 'src/util/helper.ts', name: 'formatDate', kind: 'function' },
        { file: 'src/util/helper.ts', name: 'parseDate', kind: 'function' },
      ],
      callers: [
        { file: 'src/routes/users.ts', symbol: 'listUsers', viaSymbol: 'formatDate', line: 12, rank: 90 },
        { file: 'src/routes/orders.ts', symbol: 'listOrders', viaSymbol: 'formatDate', line: 30, rank: 50 },
        { file: 'src/routes/users.ts', symbol: 'getUser', viaSymbol: 'parseDate', line: 40, rank: 90 },
      ],
      impactedEndpoints: ['GET /users', 'GET /orders'],
      factsByFile: {
        'src/routes/users.ts': { endpoints: ['GET /users'], crons: [] },
        'src/routes/orders.ts': { endpoints: ['GET /orders'], crons: ['nightly-orders'] },
      },
      degraded: false,
    };

    const out = projectBlastRadius(input);

    expect(out.changed_symbols).toEqual([
      { name: 'formatDate', file: 'src/util/helper.ts', kind: 'function' },
      { name: 'parseDate', file: 'src/util/helper.ts', kind: 'function' },
    ]);
    expect(out.downstream).toEqual([
      {
        symbol: 'formatDate',
        callers: [
          { name: 'listUsers', file: 'src/routes/users.ts', line: 12 },
          { name: 'listOrders', file: 'src/routes/orders.ts', line: 30 },
        ],
        endpoints_affected: ['GET /users', 'GET /orders'],
        crons_affected: ['nightly-orders'],
      },
      {
        symbol: 'parseDate',
        callers: [{ name: 'getUser', file: 'src/routes/users.ts', line: 40 }],
        endpoints_affected: ['GET /users'],
        crons_affected: [],
      },
    ]);
    expect(out.summary).toBe('');
  });

  it('falls back to global impactedEndpoints on the degraded path (no factsByFile)', () => {
    const input: BlastResult = {
      changedSymbols: [
        { file: 'src/util/helper.ts', name: 'formatDate', kind: 'function' },
        { file: 'src/util/helper.ts', name: 'unusedHelper', kind: 'function' },
      ],
      callers: [
        { file: 'src/routes/users.ts', symbol: 'listUsers', viaSymbol: 'formatDate', line: 12, rank: 0 },
      ],
      impactedEndpoints: ['GET /users', 'GET /orders'],
      degraded: true,
      reason: 'no_data',
    };

    const out = projectBlastRadius(input);

    expect(out.downstream).toEqual([
      {
        // Symbol with callers gets the global endpoints attached.
        symbol: 'formatDate',
        callers: [{ name: 'listUsers', file: 'src/routes/users.ts', line: 12 }],
        endpoints_affected: ['GET /users', 'GET /orders'],
        crons_affected: [],
      },
      {
        // Symbol with no callers stays empty — the fallback only targets symbols with callers.
        symbol: 'unusedHelper',
        callers: [],
        endpoints_affected: [],
        crons_affected: [],
      },
    ]);
  });

  it('does NOT apply the global fallback when some symbols were already attributed (persistent path)', () => {
    const input: BlastResult = {
      changedSymbols: [
        { file: 'h.ts', name: 'a', kind: 'function' },
        { file: 'h.ts', name: 'b', kind: 'function' },
      ],
      callers: [
        { file: 'src/routes/a.ts', symbol: 'ca', viaSymbol: 'a', line: 1, rank: 10 },
        { file: 'src/lib/util.ts', symbol: 'cb', viaSymbol: 'b', line: 2, rank: 10 },
      ],
      impactedEndpoints: ['GET /a'],
      factsByFile: { 'src/routes/a.ts': { endpoints: ['GET /a'], crons: [] } }, // util.ts absent
      degraded: false,
    };

    const out = projectBlastRadius(input);

    expect(out.downstream).toEqual([
      {
        symbol: 'a',
        callers: [{ name: 'ca', file: 'src/routes/a.ts', line: 1 }],
        endpoints_affected: ['GET /a'],
        crons_affected: [],
      },
      {
        // b's caller file has no facts; the persistent path (factsByFile present) never
        // fires the global fallback, so b's endpoints stay empty.
        symbol: 'b',
        callers: [{ name: 'cb', file: 'src/lib/util.ts', line: 2 }],
        endpoints_affected: [],
        crons_affected: [],
      },
    ]);
  });

  it('does NOT fire the global fallback on the persistent path even when zero endpoints were attributed (cap interaction)', () => {
    // Regression: the facade caps returned callers to 20 while computing impactedEndpoints
    // from the uncapped set, so a count-based gate would misfire here and stamp the global
    // list onto a status:'ready' response with no badge. The path-based gate must not.
    const input: BlastResult = {
      changedSymbols: [{ file: 'h.ts', name: 'x', kind: 'function' }],
      callers: [{ file: 'src/a.ts', symbol: 'c', viaSymbol: 'x', line: 1, rank: 10 }],
      impactedEndpoints: ['GET /beyond-cap'], // reachable only via a caller beyond the cap
      factsByFile: {}, // persistent path: facts present but this caller's file has none
      degraded: false,
    };

    const out = projectBlastRadius(input);

    expect(out.downstream).toEqual([
      { symbol: 'x', callers: [{ name: 'c', file: 'src/a.ts', line: 1 }], endpoints_affected: [], crons_affected: [] },
    ]);
  });

  it('dedupes endpoints/crons when multiple callers share a file', () => {
    const input: BlastResult = {
      changedSymbols: [{ file: 'h.ts', name: 'x', kind: 'function' }],
      callers: [
        { file: 'src/routes/a.ts', symbol: 'c1', viaSymbol: 'x', line: 1, rank: 10 },
        { file: 'src/routes/a.ts', symbol: 'c2', viaSymbol: 'x', line: 2, rank: 10 },
      ],
      impactedEndpoints: ['GET /a'],
      factsByFile: { 'src/routes/a.ts': { endpoints: ['GET /a'], crons: ['job'] } },
      degraded: false,
    };

    const out = projectBlastRadius(input);

    expect(out.downstream).toEqual([
      {
        symbol: 'x',
        callers: [
          { name: 'c1', file: 'src/routes/a.ts', line: 1 },
          { name: 'c2', file: 'src/routes/a.ts', line: 2 },
        ],
        endpoints_affected: ['GET /a'], // not duplicated
        crons_affected: ['job'],
      },
    ]);
  });

  it('preserves facade caller order within a symbol (never re-sorts by rank)', () => {
    const input: BlastResult = {
      changedSymbols: [{ file: 'h.ts', name: 'x', kind: 'function' }],
      callers: [
        { file: 'z.ts', symbol: 'first', viaSymbol: 'x', line: 1, rank: 5 }, // lower rank, arrives first
        { file: 'a.ts', symbol: 'second', viaSymbol: 'x', line: 2, rank: 99 }, // higher rank, arrives second
      ],
      impactedEndpoints: [],
      factsByFile: {},
      degraded: false,
    };

    const out = projectBlastRadius(input);

    // Order is the facade's incoming order, NOT rank order.
    expect(out.downstream).toEqual([
      {
        symbol: 'x',
        callers: [
          { name: 'first', file: 'z.ts', line: 1 },
          { name: 'second', file: 'a.ts', line: 2 },
        ],
        endpoints_affected: [],
        crons_affected: [],
      },
    ]);
  });

  it('emits a downstream entry for a changed symbol with no callers', () => {
    const input: BlastResult = {
      changedSymbols: [{ file: 'h.ts', name: 'lonely', kind: 'function' }],
      callers: [],
      impactedEndpoints: [],
      factsByFile: {},
      degraded: false,
    };

    const out = projectBlastRadius(input);

    expect(out.downstream).toEqual([
      { symbol: 'lonely', callers: [], endpoints_affected: [], crons_affected: [] },
    ]);
  });

  it('returns an empty structure for fully empty input', () => {
    const input: BlastResult = {
      changedSymbols: [],
      callers: [],
      impactedEndpoints: [],
      degraded: false,
    };

    const out = projectBlastRadius(input);

    expect(out).toEqual({ changed_symbols: [], downstream: [], summary: '' });
  });
});

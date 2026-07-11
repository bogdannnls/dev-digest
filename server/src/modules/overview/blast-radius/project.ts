import type { BlastCaller, BlastRadius, ChangedSymbol, DownstreamImpact } from '@devdigest/shared';
import type { BlastCallerRow, BlastResult } from '../../repo-intel/types.js';

/**
 * Pure projection: repo-intel facade `BlastResult` (flat) → wire `BlastRadius` (grouped).
 *
 * The facade (`repo-intel/service.ts` `getBlastRadius`) already guarantees:
 *   - callers are rank-sorted (persistent path) and capped at ≤20 PER CHANGED SYMBOL
 *     (keyed by `viaFile|viaSymbol`, or bare `viaSymbol` when `viaFile` is absent);
 *   - the declaration file is excluded from callers (a file never imports itself);
 *   - endpoints come from the caller files' precomputed facts (1-hop) PLUS any the
 *     facade resolved one further import hop out (`secondHopEndpointsByCallerFile`,
 *     keyed by the 1-hop caller file they route through). Crons stay 1-hop.
 * Therefore this projection must NOT re-sort, re-cap, re-filter, or traverse. It only
 * regroups callers under the changed symbol they reach (`viaSymbol`, disambiguated by
 * `viaFile` when present) and attributes endpoints/crons per symbol (folding the
 * per-caller-file 1-hop facts and 2-hop endpoints together).
 */
export function projectBlastRadius(input: BlastResult): BlastRadius {
  const changed_symbols: ChangedSymbol[] = input.changedSymbols.map((s) => ({
    name: s.name,
    file: s.file,
    kind: s.kind,
  }));

  // Group callers by the changed symbol they reach, preserving the facade's incoming
  // order within each group (already rank-sorted upstream — do not re-sort here).
  // Bucket key: `viaFile|viaSymbol` when the caller carries `viaFile`, else the bare
  // `viaSymbol` name. Each caller lands in EXACTLY ONE bucket (disjoint by
  // construction — the key choice is a strict if/else, never both).
  const callersByKey = new Map<string, BlastCallerRow[]>();
  for (const caller of input.callers) {
    const key = caller.viaFile ? `${caller.viaFile}|${caller.viaSymbol}` : caller.viaSymbol;
    const bucket = callersByKey.get(key);
    if (bucket) bucket.push(caller);
    else callersByKey.set(key, [caller]);
  }

  const facts = input.factsByFile ?? {};
  // Endpoints reachable one further import hop out, keyed by the 1-hop caller file
  // they route through (persistent path only). Attributed to the same symbol as
  // that caller file's direct endpoints.
  const secondHop = input.secondHopEndpointsByCallerFile ?? {};

  // One downstream entry per changed symbol (empty callers allowed, so the UI can
  // render "changed, nothing downstream"). On the persistent path we attribute
  // endpoints/crons per symbol from the precomputed facts of that symbol's caller
  // files.
  //
  // NOTE (dup-named symbols, RESOLVED via `viaFile`): the per-symbol lookup below
  // concatenates the `${symbol.file}|${symbol.name}` bucket (callers whose producer
  // set `viaFile`) with the bare `${symbol.name}` bucket (callers from an older/
  // degraded producer that never set `viaFile`). Because bucketing is disjoint (see
  // above), this concatenation can never double-count a single caller. Two changed
  // symbols that share a bare name but live in different files each pull only their
  // own `file|name` bucket, so callers no longer cross-attribute between them.
  // Fixtures that never set `viaFile` fall through entirely to the bare-name bucket
  // and behave exactly as before this change.
  //
  // GUARANTEE: `changed_symbols[i]` and `downstream[i]` describe the SAME changed
  // symbol for every index `i` — `downstream` is built via a 1:1 `.map()` over
  // `input.changedSymbols` (the same array `changed_symbols` above is derived from),
  // so callers may zip the two arrays by index.
  const downstream: DownstreamImpact[] = input.changedSymbols.map((symbol) => {
    const keyedRows = callersByKey.get(`${symbol.file}|${symbol.name}`) ?? [];
    const nameOnlyRows = callersByKey.get(symbol.name) ?? [];
    const rows = [...keyedRows, ...nameOnlyRows];
    const callers: BlastCaller[] = rows.map((c) => ({
      name: c.symbol,
      file: c.file,
      line: c.line,
    }));

    const endpoints = new Set<string>();
    const crons = new Set<string>();
    for (const row of rows) {
      const f = facts[row.file];
      if (f) {
        for (const e of f.endpoints) endpoints.add(e);
        for (const c of f.crons) crons.add(c);
      }
      // Transitive (2-hop) endpoints reachable through this caller file. Crons stay
      // 1-hop by design — a schedule two hops out isn't meaningfully "triggered by"
      // this change the way a reachable HTTP route is.
      const hop2 = secondHop[row.file];
      if (hop2) for (const e of hop2) endpoints.add(e);
    }

    return {
      symbol: symbol.name,
      callers,
      endpoints_affected: [...endpoints],
      crons_affected: [...crons],
    };
  });

  // Degraded fallback: the ripgrep path carries NO `factsByFile`, so per-symbol
  // attribution above yields nothing. Only on that path do we surface the flat
  // `impactedEndpoints` on each symbol that has a caller (deliberate over-attribution:
  // the degraded path cannot tell which symbol reaches which endpoint, and that beats
  // dropping the only endpoint signal we have).
  // We gate on the ABSENCE of `factsByFile` (the true degraded-path signal) rather
  // than on "zero endpoints attributed": on the persistent path the facade caps the
  // returned callers to 20 per changed symbol while computing `impactedEndpoints`
  // from the *uncapped* set,
  // so a count-based gate could misfire and stamp the global list onto a `status:'ready'`
  // response with no badge. Consequence of this choice: on the persistent path,
  // endpoints reachable only through callers beyond the cap are not shown — endpoints
  // track the callers we actually display.
  if (input.factsByFile == null && input.impactedEndpoints.length > 0) {
    const global = [...new Set(input.impactedEndpoints)];
    for (const entry of downstream) {
      if (entry.callers.length > 0) entry.endpoints_affected = [...global];
    }
  }

  return {
    changed_symbols,
    downstream,
    // No LLM at review time. The one-paragraph summary is an optional stretch,
    // intentionally left empty on the pure-read path.
    summary: '',
  };
}

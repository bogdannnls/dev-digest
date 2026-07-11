import type { BlastCaller, BlastRadius, ChangedSymbol, DownstreamImpact } from '@devdigest/shared';
import type { BlastCallerRow, BlastResult } from '../../repo-intel/types.js';

/**
 * Pure projection: repo-intel facade `BlastResult` (flat) → wire `BlastRadius` (grouped).
 *
 * The facade (`repo-intel/service.ts` `getBlastRadius`) already guarantees:
 *   - callers are rank-sorted (persistent path) and globally capped at 20;
 *   - the declaration file is excluded from callers (a file never imports itself);
 *   - endpoints are strictly 1-hop — direct caller files only, no import traversal.
 * Therefore this projection must NOT re-sort, re-cap, re-filter, or traverse. It only
 * regroups callers under the changed symbol they reach (`viaSymbol`) and attributes
 * endpoints/crons per symbol.
 */
export function projectBlastRadius(input: BlastResult): BlastRadius {
  const changed_symbols: ChangedSymbol[] = input.changedSymbols.map((s) => ({
    name: s.name,
    file: s.file,
    kind: s.kind,
  }));

  // Group callers by the changed symbol they reach, preserving the facade's incoming
  // order within each group (already rank-sorted upstream — do not re-sort here).
  const callersByViaSymbol = new Map<string, BlastCallerRow[]>();
  for (const caller of input.callers) {
    const bucket = callersByViaSymbol.get(caller.viaSymbol);
    if (bucket) bucket.push(caller);
    else callersByViaSymbol.set(caller.viaSymbol, [caller]);
  }

  const facts = input.factsByFile ?? {};

  // One downstream entry per changed symbol (empty callers allowed, so the UI can
  // render "changed, nothing downstream"). On the persistent path we attribute
  // endpoints/crons per symbol from the precomputed facts of that symbol's caller
  // files.
  // NOTE (dup-named symbols): grouping is by `viaSymbol`, a bare name — the facade's
  // `BlastCallerRow` carries no declaring file — so two changed symbols that share a
  // name would receive the same caller bucket (over-count). This is a facade
  // limitation (would need `viaFile` upstream); acceptable until then.
  const downstream: DownstreamImpact[] = input.changedSymbols.map((symbol) => {
    const rows = callersByViaSymbol.get(symbol.name) ?? [];
    const callers: BlastCaller[] = rows.map((c) => ({
      name: c.symbol,
      file: c.file,
      line: c.line,
    }));

    const endpoints = new Set<string>();
    const crons = new Set<string>();
    for (const row of rows) {
      const f = facts[row.file];
      if (!f) continue;
      for (const e of f.endpoints) endpoints.add(e);
      for (const c of f.crons) crons.add(c);
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
  // returned callers to 20 while computing `impactedEndpoints` from the *uncapped* set,
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

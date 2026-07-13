import type { BlastRadius } from '@devdigest/shared';

/**
 * Prompt-builder for the optional one-paragraph blast-radius risk summary.
 * Pure, no I/O — kept separate from `project.ts` so that file stays a pure
 * facade→wire projection with zero LLM concerns.
 *
 * The prompt is deliberately compact: only the TOP symbols by caller count
 * (never the full, potentially-large downstream list) plus the deduped
 * endpoint/cron lists. This is a best-effort, low-stakes summary — not the
 * structured review — so keeping the input small keeps both latency and
 * cost low.
 */

const MAX_SYMBOLS = 5;
const MAX_CALLERS_PER_SYMBOL = 5;
const MAX_ENDPOINTS = 10;
const MAX_CRONS = 10;

export const BLAST_RADIUS_SUMMARY_SYSTEM_PROMPT =
  'You are a senior engineer summarizing the "blast radius" of a pull request for a code ' +
  'reviewer. Given the changed symbols, their callers, and any affected HTTP endpoints or ' +
  'cron jobs, write ONE short paragraph (2-4 sentences) in plain English describing what ' +
  'is affected and the practical risk of the change. Do not use markdown, bullet points, ' +
  'or headings — a single plain paragraph only.';

/**
 * Builds the compact user message from already-projected `BlastRadius` data.
 * Symbols are ranked by caller count (most-called first) and capped at
 * `MAX_SYMBOLS`; each symbol's caller list is capped at `MAX_CALLERS_PER_SYMBOL`.
 */
export function buildBlastRadiusSummaryPrompt(data: BlastRadius): string {
  const topSymbols = [...data.downstream]
    .sort((a, b) => b.callers.length - a.callers.length)
    .slice(0, MAX_SYMBOLS);

  const symbolLines = topSymbols.map((entry) => {
    const callerList = entry.callers
      .slice(0, MAX_CALLERS_PER_SYMBOL)
      .map((c) => `${c.name} (${c.file}:${c.line})`)
      .join(', ');
    const suffix = callerList ? ` — called by ${callerList}` : ' — no known callers';
    return `- ${entry.symbol}: ${entry.callers.length} caller(s)${suffix}`;
  });

  const endpoints = [...new Set(data.downstream.flatMap((d) => d.endpoints_affected))].slice(
    0,
    MAX_ENDPOINTS,
  );
  const crons = [...new Set(data.downstream.flatMap((d) => d.crons_affected))].slice(0, MAX_CRONS);

  return [
    `Changed symbols (top ${topSymbols.length} by caller count):\n${symbolLines.join('\n') || '(none)'}`,
    `Affected HTTP endpoints: ${endpoints.length ? endpoints.join(', ') : '(none)'}`,
    `Affected cron jobs: ${crons.length ? crons.join(', ') : '(none)'}`,
  ].join('\n\n');
}

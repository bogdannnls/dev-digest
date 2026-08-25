/* format.ts — shared number formatting for the eval components.
   A `null` metric means its denominator was empty (contract 3.4) — a
   different statement from a score of zero. Every formatter here renders
   `null` as an em dash and MUST NOT coerce it to 0/0%. */

export const EM_DASH = "—";

/** Formats a 0..1 metric fraction as a whole-number percentage. */
export function formatPercent(value: number | null): string {
  if (value == null) return EM_DASH;
  return `${Math.round(value * 100)}%`;
}

/** Formats a percentage-point delta with an explicit sign. `null` means no
 *  comparison was possible (no previous run, or either side's metric was
 *  `null`), not "no change" — renders as an em dash rather than 0%. */
export function formatPercentDelta(value: number | null): string {
  if (value == null) return EM_DASH;
  const pct = Math.round(value * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

/** Formats a USD cost value to 4 decimal places. */
export function formatCost(value: number | null): string {
  if (value == null) return EM_DASH;
  return `$${value.toFixed(4)}`;
}

/** Formats a USD cost delta with an explicit sign. */
export function formatCostDelta(value: number | null): string {
  if (value == null) return EM_DASH;
  return `${value > 0 ? "+" : ""}$${value.toFixed(4)}`;
}

/** Formats an ISO timestamp as `YYYY-MM-DD HH:mm` without going through
 *  `Intl`/`toLocaleString` — those resolve against the runtime's locale and
 *  can render differently between the server-rendered and hydrated client
 *  pass, which is a hydration-mismatch trap for a client component. */
export function formatTimestamp(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

/** Color for a delta value: green when it moved the "good" direction, red
 *  when it moved the "bad" direction, muted when `null` (no comparison),
 *  neutral at exactly 0. `invert` flips the direction for metrics where a
 *  larger value is worse (e.g. cost). */
export function deltaColor(value: number | null, invert = false): string {
  if (value == null) return "var(--text-muted)";
  if (value === 0) return "var(--text-secondary)";
  const good = invert ? value < 0 : value > 0;
  return good ? "var(--ok)" : "var(--crit)";
}

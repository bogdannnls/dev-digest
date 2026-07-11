/* ActiveRunsStack.tsx — global bottom-right indicator for in-flight agent runs.
   Reads server-truth via useActiveRuns() (polls every 4s while any run is
   active, silent while empty). One card per run, click navigates to the PR.
   Renders nothing when no runs are active — DOM cost is zero in the idle case.

   Exit animation: when a run disappears from the query result we keep the row
   in a local map with an `exiting` flag for EXIT_MS and then drop it, so the
   card can slide out instead of vanishing.

   Elapsed-time ticking: a single 1s interval bumps a counter; each card reads
   the same `now` reference. No per-card interval. */
"use client";

import React from "react";
import Link from "next/link";
import { useActiveRuns, type ActiveRunGlobal } from "../../lib/hooks/reviews";
import { s } from "./styles";

const EXIT_MS = 220;

interface DisplayedRun extends ActiveRunGlobal {
  exiting: boolean;
}

/** Formats the elapsed distance between `ranAt` (ISO) and `now`. */
function formatElapsed(ranAt: string | null, now: number): string {
  if (!ranAt) return "";
  const started = Date.parse(ranAt);
  if (Number.isNaN(started)) return "";
  const s = Math.max(0, Math.round((now - started) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

export function ActiveRunsStack() {
  const { data } = useActiveRuns();
  const [displayed, setDisplayed] = React.useState<Map<string, DisplayedRun>>(new Map());
  const [now, setNow] = React.useState<number>(() => Date.now());

  // Merge server truth into local state so we can animate removals: a run that
  // disappears server-side is marked `exiting` for EXIT_MS, then dropped.
  React.useEffect(() => {
    const incoming = data ?? [];
    const incomingIds = new Set(incoming.map((r) => r.run_id));
    setDisplayed((prev) => {
      const next = new Map(prev);
      // Add / refresh incoming rows (server truth wins on data changes).
      for (const r of incoming) {
        next.set(r.run_id, { ...r, exiting: false });
      }
      // Mark disappeared rows as exiting so their card animates out.
      for (const [id, row] of prev) {
        if (!incomingIds.has(id) && !row.exiting) {
          next.set(id, { ...row, exiting: true });
        }
      }
      return next;
    });
  }, [data]);

  // Drop exiting rows after the animation finishes.
  React.useEffect(() => {
    const exitingIds = Array.from(displayed.values())
      .filter((r) => r.exiting)
      .map((r) => r.run_id);
    if (exitingIds.length === 0) return;
    const handle = window.setTimeout(() => {
      setDisplayed((prev) => {
        const next = new Map(prev);
        for (const id of exitingIds) next.delete(id);
        return next;
      });
    }, EXIT_MS);
    return () => window.clearTimeout(handle);
  }, [displayed]);

  // Single 1s tick shared by every card — no per-card interval.
  React.useEffect(() => {
    if (displayed.size === 0) return;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [displayed.size]);

  if (displayed.size === 0) return null;

  const rows = Array.from(displayed.values());

  return (
    <div style={s.stack} role="status" aria-live="polite" aria-label="Runs in progress">
      {rows.map((r) => (
        <Link
          key={r.run_id}
          href={`/repos/${r.repo_id}/pulls/${r.pr_number}`}
          style={{ ...s.card, ...(r.exiting ? s.cardExiting : {}) }}
          aria-label={`${r.agent_name ?? "Agent"} on PR #${r.pr_number} — click to open`}
        >
          <span style={s.spinnerWrap}>
            <span style={s.pulseHalo} aria-hidden />
            <svg width="14" height="14" viewBox="0 0 14 14" style={s.spinner} aria-hidden>
              <circle
                cx="7"
                cy="7"
                r="5.5"
                fill="none"
                stroke="var(--border-strong)"
                strokeWidth="1.5"
                opacity="0.35"
              />
              <path
                d="M 12.5 7 A 5.5 5.5 0 0 0 7 1.5"
                fill="none"
                stroke="var(--accent, #3b82f6)"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <span style={s.body}>
            <span style={s.title}>{r.agent_name ?? "Agent"}</span>
            <span style={s.sub}>{`PR #${r.pr_number} · ${formatElapsed(r.ran_at, now)}`}</span>
          </span>
        </Link>
      ))}
    </div>
  );
}

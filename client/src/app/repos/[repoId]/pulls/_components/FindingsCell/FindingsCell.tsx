'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { SeverityBadge } from '@devdigest/ui';
import type { PrMeta } from '@devdigest/shared';

type SevKey = 'CRITICAL' | 'WARNING' | 'SUGGESTION';
const SEVERITIES: SevKey[] = ['CRITICAL', 'WARNING', 'SUGGESTION'];
const HOVER_DELAY_MS = 150;

function Tooltip({
  severity,
  bucket,
  baseHref,
  onTitleClick,
  open,
}: {
  severity: SevKey;
  bucket: PrMeta['findings']['CRITICAL'];
  baseHref: string;
  onTitleClick: (id: string) => void;
  open: boolean;
}) {
  if (!open) return null;
  const overflow = Math.max(0, bucket.count - bucket.titles.length);
  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute',
        top: '100%',
        right: 0,
        marginTop: 6,
        zIndex: 10,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 8,
        minWidth: 240,
        boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>
        {severity} ({bucket.count})
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {bucket.titles.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => onTitleClick(t.id)}
              style={{
                background: 'transparent',
                border: 0,
                color: 'var(--text)',
                textAlign: 'left',
                padding: '4px 0',
                cursor: 'pointer',
                width: '100%',
              }}
            >
              {t.title}
            </button>
          </li>
        ))}
      </ul>
      {overflow > 0 && (
        <a
          href={`${baseHref}?tab=findings&severity=${severity}`}
          style={{
            display: 'inline-block',
            marginTop: 4,
            fontSize: 12,
            color: 'var(--text-muted)',
          }}
        >
          +{overflow} more
        </a>
      )}
    </div>
  );
}

function SeverityCell({
  severity,
  bucket,
  baseHref,
  onTitleClick,
}: {
  severity: SevKey;
  bucket: PrMeta['findings']['CRITICAL'];
  baseHref: string;
  onTitleClick: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const onEnter = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), HOVER_DELAY_MS);
  };
  const onLeave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), HOVER_DELAY_MS);
  };

  return (
    <span
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}
      aria-label={`${severity.toLowerCase()} findings`}
      aria-describedby={open ? `tooltip-${severity}` : undefined}
    >
      <SeverityBadge severity={severity} compact />
      <span className="mono">{bucket.count}</span>
      <Tooltip
        severity={severity}
        bucket={bucket}
        baseHref={baseHref}
        onTitleClick={onTitleClick}
        open={open && bucket.titles.length > 0}
      />
    </span>
  );
}

export function FindingsCell({ pr, repoId }: { pr: PrMeta; repoId: string }) {
  const router = useRouter();
  const reviewed = pr.score != null;
  if (!reviewed) return <span style={{ color: 'var(--text-muted)' }}>—</span>;

  const baseHref = `/repos/${repoId}/pulls/${pr.number}`;
  const onTitleClick = (id: string) =>
    router.push(`${baseHref}?tab=findings#finding-${id}`);

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {SEVERITIES.map((sev) => (
        <SeverityCell
          key={sev}
          severity={sev}
          bucket={pr.findings[sev]}
          baseHref={baseHref}
          onTitleClick={onTitleClick}
        />
      ))}
    </div>
  );
}

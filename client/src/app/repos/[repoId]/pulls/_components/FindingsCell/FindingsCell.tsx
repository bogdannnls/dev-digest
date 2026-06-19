'use client';

import React from 'react';
import { SeverityBadge } from '@devdigest/ui';
import type { PrMeta } from '@devdigest/shared';

type SevKey = 'CRITICAL' | 'WARNING' | 'SUGGESTION';
const SEVERITIES: SevKey[] = ['CRITICAL', 'WARNING', 'SUGGESTION'];

export function FindingsCell({ pr, repoId: _repoId }: { pr: PrMeta; repoId: string }) {
  const reviewed = pr.score != null;
  if (!reviewed) return <span style={{ color: 'var(--text-muted)' }}>—</span>;

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {SEVERITIES.map((sev) => {
        const bucket = pr.findings[sev];
        return (
          <span key={sev} aria-label={`${sev.toLowerCase()} findings`}>
            <SeverityBadge severity={sev} compact />
            <span style={{ marginLeft: 4 }} className="mono">
              {bucket.count}
            </span>
          </span>
        );
      })}
    </div>
  );
}

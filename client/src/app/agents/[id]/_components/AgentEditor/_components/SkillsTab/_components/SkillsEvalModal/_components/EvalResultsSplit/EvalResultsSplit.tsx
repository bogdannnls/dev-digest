'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { SkillsEvalResult } from '@devdigest/shared';
import { diffFindings, type AnnotatedFinding } from './diffFindings';
import { FindingRow } from '../FindingRow';
import { s } from './styles';

export function EvalResultsSplit({ result }: { result: SkillsEvalResult }) {
  const t = useTranslations('agents.eval');

  const { withAnnotated, withoutAnnotated } = useMemo(
    () => diffFindings(result.with_skills.findings, result.without_skills.findings),
    [result],
  );

  return (
    <div style={s.split}>
      <Column
        testId="with-column"
        title={t('withColumn')}
        findings={withAnnotated}
        tokens={result.with_skills.tokensIn + result.with_skills.tokensOut}
        costUsd={result.with_skills.costUsd}
        emptyLabel={t('noFindings')}
        tokensLabel={(n: number) => t('tokens', { n })}
        costLabel={(cost: string) => t('cost', { cost })}
      />
      <Column
        testId="without-column"
        title={t('withoutColumn')}
        findings={withoutAnnotated}
        tokens={result.without_skills.tokensIn + result.without_skills.tokensOut}
        costUsd={result.without_skills.costUsd}
        emptyLabel={t('noFindings')}
        tokensLabel={(n: number) => t('tokens', { n })}
        costLabel={(cost: string) => t('cost', { cost })}
      />
    </div>
  );
}

interface ColumnProps {
  testId: string;
  title: string;
  findings: AnnotatedFinding[];
  tokens: number;
  costUsd: number | null;
  emptyLabel: string;
  tokensLabel: (n: number) => string;
  costLabel: (cost: string) => string;
}

function Column({
  testId,
  title,
  findings,
  tokens,
  costUsd,
  emptyLabel,
  tokensLabel,
  costLabel,
}: ColumnProps) {
  return (
    <div style={s.column} data-testid={testId}>
      <div style={s.header}>
        <h3 style={s.heading}>
          {title} <small>({findings.length})</small>
        </h3>
        <div style={s.meta}>
          <span>{tokensLabel(tokens)}</span>
          {costUsd != null && <span>{costLabel(costUsd.toFixed(4))}</span>}
        </div>
      </div>
      <div style={s.body}>
        {findings.length === 0 ? (
          <p style={s.empty}>{emptyLabel}</p>
        ) : (
          findings.map((f, i) => (
            <FindingRow key={`${f.file}:${f.start_line}:${i}`} finding={f} />
          ))
        )}
      </div>
    </div>
  );
}

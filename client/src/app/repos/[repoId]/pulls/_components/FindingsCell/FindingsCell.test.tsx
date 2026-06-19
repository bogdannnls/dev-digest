import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FindingsCell } from './FindingsCell';
import type { PrMeta } from '@devdigest/shared';

const pr = (findings: PrMeta['findings']): PrMeta =>
  ({
    id: 'pr-1',
    number: 1,
    title: 't',
    author: 'a',
    branch: 'b',
    base: 'main',
    head_sha: 's',
    additions: 0,
    deletions: 0,
    files_count: 0,
    status: 'needs_review',
    score: 70,
    findings,
  } as PrMeta);

describe('FindingsCell', () => {
  it('renders all three severity badges with their counts', () => {
    render(
      <FindingsCell
        pr={pr({
          CRITICAL: { count: 2, titles: [] },
          WARNING: { count: 0, titles: [] },
          SUGGESTION: { count: 5, titles: [] },
        })}
        repoId="r1"
      />,
    );
    expect(screen.getByLabelText(/critical/i)).toHaveTextContent('2');
    expect(screen.getByLabelText(/warning/i)).toHaveTextContent('0');
    expect(screen.getByLabelText(/suggestion/i)).toHaveTextContent('5');
  });

  it('renders an em-dash when there is no review (score is null)', () => {
    render(
      <FindingsCell
        pr={
          {
            ...pr({
              CRITICAL: { count: 0, titles: [] },
              WARNING: { count: 0, titles: [] },
              SUGGESTION: { count: 0, titles: [] },
            }),
            score: null,
          } as PrMeta
        }
        repoId="r1"
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FindingsCell } from './FindingsCell';
import type { PrMeta } from '@devdigest/shared';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

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

  it('shows finding titles on hover and deep-links on click', async () => {
    render(
      <FindingsCell
        pr={pr({
          CRITICAL: {
            count: 2,
            titles: [
              { id: 'f1', title: 'Rate limit bypass' },
              { id: 'f2', title: 'Auth check skipped' },
            ],
          },
          WARNING: { count: 0, titles: [] },
          SUGGESTION: { count: 0, titles: [] },
        })}
        repoId="r1"
      />,
    );

    const user = userEvent.setup();
    const badge = screen.getByLabelText(/critical/i);
    await user.hover(badge);

    // Tooltip should appear with both titles
    expect(await screen.findByText(/Rate limit bypass/)).toBeInTheDocument();
    expect(screen.getByText(/Auth check skipped/)).toBeInTheDocument();

    await user.click(screen.getByText(/Rate limit bypass/));
    expect(push).toHaveBeenCalledWith(
      expect.stringContaining('/pulls/1?tab=findings#finding-f1'),
    );
  });

  it('shows "+N more" link when count exceeds titles length', async () => {
    render(
      <FindingsCell
        pr={pr({
          CRITICAL: {
            count: 8,
            titles: [
              { id: 'f1', title: 'A' },
              { id: 'f2', title: 'B' },
              { id: 'f3', title: 'C' },
              { id: 'f4', title: 'D' },
              { id: 'f5', title: 'E' },
            ],
          },
          WARNING: { count: 0, titles: [] },
          SUGGESTION: { count: 0, titles: [] },
        })}
        repoId="r1"
      />,
    );
    const user = userEvent.setup();
    await user.hover(screen.getByLabelText(/critical/i));
    const moreLink = await screen.findByText(/\+3 more/);
    expect(moreLink).toBeInTheDocument();
    await user.click(moreLink);
    expect(push).toHaveBeenCalledWith(
      expect.stringContaining('?tab=findings&severity=CRITICAL'),
    );
  });
});

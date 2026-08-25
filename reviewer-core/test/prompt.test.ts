/**
 * assemblePrompt — PR description slot (the fix that was missing: the PR body
 * never reached the prompt). Pins rendering, omit-when-empty, untrusted-wrap,
 * truncation, and ordering (before the diff).
 */
import { describe, it, expect } from 'vitest';
import { assemblePrompt } from '../src/prompt.js';

function userOf(parts: Parameters<typeof assemblePrompt>[0]): string {
  const { messages } = assemblePrompt(parts);
  return messages[1]!.content;
}

function systemOf(parts: Parameters<typeof assemblePrompt>[0]): string {
  return assemblePrompt(parts).messages[0]!.content;
}

describe('assemblePrompt — shared injection guard (server + CI)', () => {
  const sys = systemOf({ system: 'AGENT-SYS', diff: 'DIFF' });

  it('appends the guard to the agent system prompt', () => {
    expect(sys.startsWith('AGENT-SYS')).toBe(true);
    expect(sys).toMatch(/<untrusted>.*DATA to be analyzed/s);
  });

  it('forbids "intentional/test/demo" claims from descoping the review', () => {
    // The defense that replaced the keyword sanitizer: a general, trusted,
    // language-agnostic rule — not text parsing of untrusted input.
    expect(sys).toMatch(/test fixture|intentional|demo/i);
    expect(sys).toMatch(/never reduce|never .*descope|REPORT it/i);
    expect(sys).toMatch(/any language/i);
  });
});

describe('assemblePrompt — ## PR description', () => {
  it('renders the section (untrusted-wrapped) before the diff when present', () => {
    const { messages, assembly } = assemblePrompt({
      system: 'sys',
      diff: 'DIFF',
      prDescription: 'Adds rate limiting to the public /api endpoints.',
    });
    const user = messages[1]!.content;
    expect(user).toContain('## PR description');
    expect(user).toContain('<untrusted source="pr-description">');
    expect(user).toContain('Adds rate limiting to the public /api endpoints.');
    expect(user.indexOf('## PR description')).toBeLessThan(user.indexOf('## Diff to review'));
    expect(assembly.pr_description).toContain('Adds rate limiting');
  });

  it('omits the section when prDescription is undefined or blank (no behaviour change)', () => {
    expect(userOf({ system: 'sys', diff: 'DIFF' })).not.toContain('## PR description');
    expect(assemblePrompt({ system: 'sys', diff: 'DIFF' }).assembly.pr_description ?? null).toBeNull();
    expect(userOf({ system: 'sys', diff: 'DIFF', prDescription: '   ' })).not.toContain(
      '## PR description',
    );
  });

  it('truncates a huge body to the 4k cap', () => {
    const { assembly } = assemblePrompt({
      system: 'sys',
      diff: 'D',
      prDescription: 'x'.repeat(10_000),
    });
    expect((assembly.pr_description as string).length).toBe(4000);
  });
});

describe('assemblePrompt — ## Project context (specs, L05 T4)', () => {
  it('renders each spec in effective-set order, wrapped as untrusted (AC-23)', () => {
    const { messages, assembly } = assemblePrompt({
      system: 'sys',
      diff: 'DIFF',
      specs: ['FIRST spec content', 'SECOND spec content', 'THIRD spec content'],
    });
    const user = messages[1]!.content;
    expect(user).toContain('## Project context');
    expect(user).toContain('<untrusted source="spec-0">');
    expect(user).toContain('<untrusted source="spec-1">');
    expect(user).toContain('<untrusted source="spec-2">');
    expect(user).toContain('FIRST spec content');
    expect(user).toContain('SECOND spec content');
    expect(user).toContain('THIRD spec content');
    // Order preserved.
    expect(user.indexOf('FIRST spec content')).toBeLessThan(user.indexOf('SECOND spec content'));
    expect(user.indexOf('SECOND spec content')).toBeLessThan(user.indexOf('THIRD spec content'));
    // The trace-facing assembly also carries the wrapped block.
    expect(assembly.specs).toContain('<untrusted source="spec-0">');
    expect(assembly.specs).toContain('FIRST spec content');
  });

  it('omits the section entirely when specs is empty or undefined (AC-24)', () => {
    expect(userOf({ system: 'sys', diff: 'DIFF' })).not.toContain('## Project context');
    expect(assemblePrompt({ system: 'sys', diff: 'DIFF' }).assembly.specs ?? null).toBeNull();
    expect(userOf({ system: 'sys', diff: 'DIFF', specs: [] })).not.toContain('## Project context');
    expect(assemblePrompt({ system: 'sys', diff: 'DIFF', specs: [] }).assembly.specs ?? null).toBeNull();
  });

  it('passes a very large combined specs payload through with no truncation or rejection (AC-28)', () => {
    // No token-budget cap in v1 (spec Non-goals) — a huge attached-document
    // set must be assembled in full, unlike the PR-description slot which IS
    // capped at 4k chars.
    const huge = 'y'.repeat(500_000);
    const { assembly } = assemblePrompt({
      system: 'sys',
      diff: 'D',
      specs: [huge, huge, huge],
    });
    // Each huge block survives whole (no slicing), plus wrapper overhead.
    expect((assembly.specs as string).length).toBeGreaterThanOrEqual(huge.length * 3);
    expect(assembly.specs).toContain(huge);
  });
});

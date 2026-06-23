import { describe, it, expect } from 'vitest';
import { parseSkillMarkdown } from '../src/modules/skills/helpers.js';
import { ValidationError } from '../src/platform/errors.js';

describe('parseSkillMarkdown', () => {
  it('uses frontmatter when present', () => {
    const raw = `---
name: my-skill
description: A description.
type: security
---
## Body

Content here.`;
    const out = parseSkillMarkdown(raw, 'unused.md');
    expect(out.name).toBe('my-skill');
    expect(out.description).toBe('A description.');
    expect(out.type).toBe('security');
    expect(out.body).toContain('## Body');
    expect(out.warnings).toEqual([]);
  });

  it('derives name from H1 when frontmatter omits it', () => {
    const raw = `# Heading Name

A paragraph that explains it.`;
    const out = parseSkillMarkdown(raw, 'fallback.md');
    expect(out.name).toBe('Heading Name');
    expect(out.description).toBe('A paragraph that explains it');
    expect(out.type).toBe('custom');
  });

  it('falls back to filename when no name available', () => {
    const out = parseSkillMarkdown('Body text.', 'my_cool skill.md');
    expect(out.name).toBe('my-cool-skill');
  });

  it('coerces unknown type and emits a warning', () => {
    const raw = `---
name: x
type: nonsense
---
Body.`;
    const out = parseSkillMarkdown(raw, undefined);
    expect(out.type).toBe('custom');
    expect(out.warnings.some((w) => w.includes('nonsense'))).toBe(true);
  });

  it('warns and ignores unknown frontmatter keys', () => {
    const raw = `---
name: x
weird_key: ignored
---
Body.`;
    const out = parseSkillMarkdown(raw, undefined);
    expect(out.warnings.some((w) => w.includes('weird_key'))).toBe(true);
  });

  it('caps the derived description at 200 chars and trims a trailing period', () => {
    const long = 'x'.repeat(250) + '.';
    const out = parseSkillMarkdown(`# Title\n\n${long}`, undefined);
    expect(out.description.length).toBe(200);
    expect(out.description.endsWith('.')).toBe(false);
  });

  it('throws ValidationError with empty_body code when body is empty', () => {
    const raw = `---
name: x
---
`;
    expect(() => parseSkillMarkdown(raw, undefined)).toThrowError(ValidationError);
  });

  it('treats malformed frontmatter (no closing fence) as body', () => {
    const raw = `---
name: x
no closing fence here

# Real Title

Body paragraph.`;
    const out = parseSkillMarkdown(raw, undefined);
    expect(out.name).toBe('Real Title');
    expect(out.body).toContain('---');
  });
});

import { describe, it, expect } from 'vitest';
import { detectProvider, parseRepoUrl, withForgeToken } from '../src/modules/repos/helpers.js';

describe('detectProvider', () => {
  it('returns github for github.com URLs', () => {
    expect(detectProvider('https://github.com/owner/repo')).toBe('github');
    expect(detectProvider('git@github.com:owner/repo.git')).toBe('github');
  });
  it('returns bitbucket for bitbucket.org URLs', () => {
    expect(detectProvider('https://bitbucket.org/workspace/repo')).toBe('bitbucket');
    expect(detectProvider('git@bitbucket.org:workspace/repo.git')).toBe('bitbucket');
  });
});

describe('parseRepoUrl', () => {
  it('parses a github https URL', () => {
    const r = parseRepoUrl('https://github.com/myorg/myrepo');
    expect(r).toEqual({ owner: 'myorg', name: 'myrepo', provider: 'github' });
  });
  it('parses a bitbucket https URL', () => {
    const r = parseRepoUrl('https://bitbucket.org/myworkspace/myrepo');
    expect(r).toEqual({ owner: 'myworkspace', name: 'myrepo', provider: 'bitbucket' });
  });
  it('parses a bitbucket ssh URL', () => {
    const r = parseRepoUrl('git@bitbucket.org:myworkspace/myrepo.git');
    expect(r).toEqual({ owner: 'myworkspace', name: 'myrepo', provider: 'bitbucket' });
  });
  it('throws on unrecognised URL', () => {
    expect(() => parseRepoUrl('https://gitlab.com/owner/repo')).toThrow();
  });
});

describe('withForgeToken', () => {
  it('embeds github token', () => {
    const url = withForgeToken('https://github.com/o/r.git', 'github', { token: 'ghp_abc' });
    expect(url).toContain('x-access-token:ghp_abc@github.com');
  });
  it('embeds bitbucket OAuth token', () => {
    const url = withForgeToken('https://bitbucket.org/o/r.git', 'bitbucket', { token: 'bb_tok' });
    expect(url).toContain('x-token-auth:bb_tok@bitbucket.org');
  });
  it('embeds bitbucket app password', () => {
    const url = withForgeToken('https://bitbucket.org/o/r.git', 'bitbucket', {
      username: 'user',
      appPassword: 'pass',
    });
    expect(url).toContain('user:pass@bitbucket.org');
  });
  it('returns url unchanged when no credentials', () => {
    const url = withForgeToken('https://bitbucket.org/o/r.git', 'bitbucket', {});
    expect(url).toBe('https://bitbucket.org/o/r.git');
  });
  it('prefers token over appPassword when both present (bitbucket)', () => {
    const url = withForgeToken('https://bitbucket.org/o/r.git', 'bitbucket', {
      token: 'tok',
      username: 'user',
      appPassword: 'pass',
    });
    expect(url).toContain('x-token-auth:tok@bitbucket.org');
    expect(url).not.toContain('user');
  });
});

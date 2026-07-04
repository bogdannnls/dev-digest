/**
 * Homework l03 verification — path-only classification.
 *
 * 15 assertions, 5 per SmartDiffRole. Uses the singular `classifyFile(path)`
 * surface (no size input). Full internal coverage (priority order, size
 * override, edge cases) lives in `smart-diff/classifier.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { classifyFile } from './smart-diff/classifier.js';

describe('classifyFile — boilerplate', () => {
  it('classifies pnpm-lock.yaml as boilerplate', () => {
    expect(classifyFile('pnpm-lock.yaml')).toBe('boilerplate');
  });

  it('classifies a migration file inside a migrations/ directory as boilerplate', () => {
    expect(classifyFile('server/src/db/migrations/0001_init.sql')).toBe('boilerplate');
  });

  it('classifies a build output file as boilerplate', () => {
    expect(classifyFile('client/dist/bundle.js')).toBe('boilerplate');
  });

  it('classifies a snapshot fixture as boilerplate', () => {
    expect(classifyFile('src/components/Button/__snapshots__/Button.snap')).toBe('boilerplate');
  });

  it('classifies a vendored node_modules file as boilerplate', () => {
    expect(classifyFile('packages/foo/node_modules/lib/index.js')).toBe('boilerplate');
  });
});

describe('classifyFile — wiring', () => {
  it('classifies a barrel index.ts as wiring', () => {
    expect(classifyFile('src/index.ts')).toBe('wiring');
  });

  it('classifies package.json as wiring', () => {
    expect(classifyFile('package.json')).toBe('wiring');
  });

  it('classifies next.config.mjs as wiring', () => {
    expect(classifyFile('next.config.mjs')).toBe('wiring');
  });

  it('classifies a .github/ workflow as wiring', () => {
    expect(classifyFile('.github/workflows/ci.yml')).toBe('wiring');
  });

  it('classifies tsconfig.json as wiring', () => {
    expect(classifyFile('tsconfig.json')).toBe('wiring');
  });
});

describe('classifyFile — core', () => {
  it('classifies a service module as core', () => {
    expect(classifyFile('src/modules/reviews/service.ts')).toBe('core');
  });

  it('classifies a client hook as core', () => {
    expect(classifyFile('client/src/lib/hooks/reviews.ts')).toBe('core');
  });

  it('classifies a route file as core', () => {
    expect(classifyFile('server/src/modules/pulls/routes.ts')).toBe('core');
  });

  it('classifies a review plan module as core', () => {
    expect(classifyFile('reviewer-core/src/review/plan.ts')).toBe('core');
  });

  it('classifies an adapter file as core', () => {
    expect(classifyFile('server/src/adapters/github/octokit.ts')).toBe('core');
  });
});

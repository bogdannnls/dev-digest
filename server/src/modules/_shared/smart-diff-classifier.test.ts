import { describe, it, expect } from 'vitest';
import { classifyFiles } from './smart-diff-classifier.js';

/** Shorthand for a zero-diff file (patterns win, size override irrelevant). */
function file(path: string, additions = 0, deletions = 0) {
  return { path, additions, deletions };
}

describe('classifyFiles — boilerplate patterns', () => {
  it('classifies lockfiles as boilerplate', () => {
    const result = classifyFiles([file('pnpm-lock.yaml')]);
    expect(result.get('pnpm-lock.yaml')).toBe('boilerplate');
  });

  it('classifies files under a build dir segment as boilerplate', () => {
    const result = classifyFiles([file('packages/foo/dist/bundle.js')]);
    expect(result.get('packages/foo/dist/bundle.js')).toBe('boilerplate');
  });

  it('classifies minified files as boilerplate', () => {
    const result = classifyFiles([file('src/foo.min.js')]);
    expect(result.get('src/foo.min.js')).toBe('boilerplate');
  });

  it('classifies node_modules files as boilerplate', () => {
    const result = classifyFiles([file('node_modules/lib/index.js')]);
    expect(result.get('node_modules/lib/index.js')).toBe('boilerplate');
  });

  it('classifies vendored files as boilerplate', () => {
    const result = classifyFiles([file('client/vendor/lodash.js')]);
    expect(result.get('client/vendor/lodash.js')).toBe('boilerplate');
  });

  it('classifies files under a snapshot dir segment as boilerplate', () => {
    const result = classifyFiles([file('src/__snapshots__/foo.snap')]);
    expect(result.get('src/__snapshots__/foo.snap')).toBe('boilerplate');
  });

  it('classifies .snap-suffixed files as boilerplate', () => {
    const result = classifyFiles([file('src/components/Button.test.ts.snap')]);
    expect(result.get('src/components/Button.test.ts.snap')).toBe('boilerplate');
  });

  it('classifies SQL files under a migrations dir as boilerplate', () => {
    const result = classifyFiles([file('server/src/db/migrations/0001_init.sql')]);
    expect(result.get('server/src/db/migrations/0001_init.sql')).toBe('boilerplate');
  });

  it('does NOT classify a migrations-dir file with a non-.sql suffix as boilerplate via the migration rule', () => {
    const result = classifyFiles([file('server/src/db/migrations/README.md')]);
    expect(result.get('server/src/db/migrations/README.md')).toBe('core');
  });
});

describe('classifyFiles — wiring patterns', () => {
  it('classifies barrel files as wiring', () => {
    const result = classifyFiles([file('src/components/foo/index.ts')]);
    expect(result.get('src/components/foo/index.ts')).toBe('wiring');
  });

  it('classifies next.config.mjs as wiring', () => {
    const result = classifyFiles([file('next.config.mjs')]);
    expect(result.get('next.config.mjs')).toBe('wiring');
  });

  it('classifies tsconfig.json as wiring', () => {
    const result = classifyFiles([file('packages/x/tsconfig.json')]);
    expect(result.get('packages/x/tsconfig.json')).toBe('wiring');
  });

  it('classifies eslint.config.js as wiring', () => {
    const result = classifyFiles([file('client/eslint.config.js')]);
    expect(result.get('client/eslint.config.js')).toBe('wiring');
  });

  it('classifies vitest.config.ts as wiring', () => {
    const result = classifyFiles([file('packages/x/vitest.config.ts')]);
    expect(result.get('packages/x/vitest.config.ts')).toBe('wiring');
  });

  it('classifies package.json as wiring', () => {
    const result = classifyFiles([file('package.json')]);
    expect(result.get('package.json')).toBe('wiring');
  });

  it('classifies files under .github/ as wiring', () => {
    const result = classifyFiles([file('.github/workflows/ci.yml')]);
    expect(result.get('.github/workflows/ci.yml')).toBe('wiring');
  });

  it('classifies Dockerfile as wiring', () => {
    const result = classifyFiles([file('Dockerfile')]);
    expect(result.get('Dockerfile')).toBe('wiring');
  });

  it('classifies docker-compose*.yml as wiring', () => {
    const result = classifyFiles([file('docker-compose.dev.yml')]);
    expect(result.get('docker-compose.dev.yml')).toBe('wiring');
  });

  it('classifies .env.example as wiring', () => {
    const result = classifyFiles([file('.env.example')]);
    expect(result.get('.env.example')).toBe('wiring');
  });
});

describe('classifyFiles — core (default)', () => {
  it('classifies an ordinary server route file as core', () => {
    const result = classifyFiles([file('server/src/modules/pulls/routes.ts')]);
    expect(result.get('server/src/modules/pulls/routes.ts')).toBe('core');
  });

  it('classifies an ordinary client hook file as core', () => {
    const result = classifyFiles([file('client/src/lib/hooks/reviews.ts')]);
    expect(result.get('client/src/lib/hooks/reviews.ts')).toBe('core');
  });
});

describe('classifyFiles — priority (boilerplate wins over wiring)', () => {
  it('classifies a barrel file under a build dir as boilerplate, not wiring', () => {
    const result = classifyFiles([file('src/dist/index.ts')]);
    expect(result.get('src/dist/index.ts')).toBe('boilerplate');
  });
});

describe('classifyFiles — size override', () => {
  it('reclassifies an unfamiliar-extension core file over the threshold as boilerplate', () => {
    const result = classifyFiles([file('data/dump.dat', 501, 0)]);
    expect(result.get('data/dump.dat')).toBe('boilerplate');
  });

  it('keeps an unfamiliar-extension core file at/under the threshold as core', () => {
    const result = classifyFiles([file('data/dump.dat', 499, 0)]);
    expect(result.get('data/dump.dat')).toBe('core');
  });

  it('does NOT override a familiar-extension core file regardless of size', () => {
    const result = classifyFiles([file('src/foo.ts', 5000, 0)]);
    expect(result.get('src/foo.ts')).toBe('core');
  });

  it('sums additions and deletions when checking the threshold', () => {
    const result = classifyFiles([file('data/dump.dat', 300, 300)]);
    expect(result.get('data/dump.dat')).toBe('boilerplate');
  });
});

describe('classifyFiles — empty input', () => {
  it('returns an empty Map without throwing', () => {
    expect(() => classifyFiles([])).not.toThrow();
    const result = classifyFiles([]);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });
});

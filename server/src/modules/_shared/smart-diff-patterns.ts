/**
 * Smart Diff classification constants + pure path helpers.
 *
 * Pure TS module: zero I/O, zero framework imports, zero side effects.
 * All rules are encoded as plain string / array / Set / segment operations —
 * deliberately no glob library (mirrors `isJunkPath` precedent at
 * `server/src/modules/repo-intel/service.ts:730-733`).
 *
 * Consumed by the classifier (T2) and the composer (T3). See spec §5.
 */

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Last path segment after the final `/`. Returns the whole string if no `/`. */
export function basenameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Splits a path into its `/`-delimited segments. */
export function segmentsOf(path: string): string[] {
  return path.split('/');
}

/**
 * Everything from the last `.` in the basename (including the dot), or `''`
 * if the basename has no extension. A basename that starts with `.` and has
 * no further `.` (e.g. `.env`, `.gitignore`) is treated as extension-less —
 * the leading dot is a hidden-file marker, not an extension separator.
 */
export function extensionOf(path: string): string {
  const base = basenameOf(path);
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return '';
  return base.slice(idx);
}

// ---------------------------------------------------------------------------
// Lockfiles
// ---------------------------------------------------------------------------

export const LOCK_FILENAMES: ReadonlySet<string> = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'uv.lock',
  'composer.lock',
  'go.sum',
  'mix.lock',
  'Podfile.lock',
]);

// ---------------------------------------------------------------------------
// Generated / vendored / build output directories
// ---------------------------------------------------------------------------

export const BUILD_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
]);

export const VENDORED_DIR_SEGMENTS: ReadonlySet<string> = new Set(['node_modules', 'vendor']);

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export const SNAPSHOT_DIR_SEGMENTS: ReadonlySet<string> = new Set(['__snapshots__']);
export const SNAPSHOT_SUFFIX = '.snap';

// ---------------------------------------------------------------------------
// Minified / sourcemap assets
// ---------------------------------------------------------------------------

export const MINIFIED_SUFFIXES: readonly string[] = ['.min.js', '.min.css', '.map'];

// ---------------------------------------------------------------------------
// Migrations — both the directory segment AND the suffix must match
// ---------------------------------------------------------------------------

export const MIGRATION_DIR_SEGMENT = 'migrations';
export const MIGRATION_SUFFIX = '.sql';

// ---------------------------------------------------------------------------
// Barrel files
// ---------------------------------------------------------------------------

export const BARREL_BASENAMES: ReadonlySet<string> = new Set([
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'mod.rs',
  '__init__.py',
]);

// ---------------------------------------------------------------------------
// Config files
// ---------------------------------------------------------------------------

/** Basename suffixes that mark a file as a config file, regardless of prefix. */
const CONFIG_SUFFIXES: readonly string[] = [
  '.config.ts',
  '.config.js',
  '.config.mjs',
  '.config.cjs',
  '.config.json',
];

/** Predicate: does this basename end with one of the recognized config suffixes? */
export function CONFIG_SUFFIX_PATTERN(basename: string): boolean {
  return CONFIG_SUFFIXES.some((suffix) => basename.endsWith(suffix));
}

export const CONFIG_BASENAME_PREFIXES: readonly string[] = [
  'tsconfig',
  'next.config',
  'vitest.config',
  'vite.config',
  'drizzle.config',
  'tailwind.config',
  'postcss.config',
  'eslint.config',
  '.eslintrc',
  '.prettierrc',
];

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

export const MANIFEST_BASENAMES: ReadonlySet<string> = new Set([
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'Gemfile',
  'go.mod',
]);

// ---------------------------------------------------------------------------
// CI / infra
// ---------------------------------------------------------------------------

export const CI_DIR_PREFIX = '.github/';

export const CI_BASENAMES: ReadonlySet<string> = new Set(['Dockerfile', '.gitlab-ci.yml']);

const DOCKER_COMPOSE_PREFIX = 'docker-compose';
const DOCKER_COMPOSE_SUFFIX = '.yml';

/** Predicate: does this basename look like a `docker-compose*.yml` file? */
export function isDockerComposeBasename(basename: string): boolean {
  return basename.startsWith(DOCKER_COMPOSE_PREFIX) && basename.endsWith(DOCKER_COMPOSE_SUFFIX);
}

// ---------------------------------------------------------------------------
// Env files
// ---------------------------------------------------------------------------

export const ENV_BASENAME_PREFIX = '.env';

// ---------------------------------------------------------------------------
// Familiar source extensions
// ---------------------------------------------------------------------------

export const FAMILIAR_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.swift',
  '.scala',
  '.ex',
  '.exs',
  '.clj',
  '.css',
  '.scss',
  '.md',
  '.sql',
  '.yaml',
  '.yml',
  '.json',
  '.toml',
]);

// ---------------------------------------------------------------------------
// Size thresholds
// ---------------------------------------------------------------------------

/** Above this many changed lines in a single file, size overrides classification. */
export const SIZE_OVERRIDE_THRESHOLD_LINES = 500;

/** Above this many total changed lines across the diff, the composer flags "too big". */
export const TOO_BIG_TOTAL_LINES_THRESHOLD = 1000;

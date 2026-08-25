/**
 * Smart Diff file classifier.
 *
 * Pure TS module: zero I/O, zero framework imports beyond the shared contract
 * type. Classifies each changed file into a `SmartDiffRole` using the
 * priority-ordered rules in spec §5: boilerplate > wiring > core, with a
 * size-override pass that can reclassify an unfamiliar-extension `core` file
 * to `boilerplate` when it crosses the changed-lines threshold.
 *
 * Consumes constants + helpers from `./smart-diff-patterns.js` (T1). Consumed
 * by the composer (T3).
 */

import type { SmartDiffRole } from '@devdigest/shared';
import {
  basenameOf,
  segmentsOf,
  extensionOf,
  LOCK_FILENAMES,
  BUILD_DIR_SEGMENTS,
  VENDORED_DIR_SEGMENTS,
  SNAPSHOT_DIR_SEGMENTS,
  SNAPSHOT_SUFFIX,
  MINIFIED_SUFFIXES,
  MIGRATION_DIR_SEGMENT,
  MIGRATION_SUFFIX,
  BARREL_BASENAMES,
  CONFIG_SUFFIX_PATTERN,
  CONFIG_BASENAME_PREFIXES,
  MANIFEST_BASENAMES,
  CI_DIR_PREFIX,
  CI_BASENAMES,
  isDockerComposeBasename,
  ENV_BASENAME_PREFIX,
  FAMILIAR_EXTENSIONS,
  SIZE_OVERRIDE_THRESHOLD_LINES,
} from './smart-diff-patterns.js';

/** Minimal shape the classifier needs from a changed file. */
export interface SmartDiffClassifierInput {
  path: string;
  additions: number;
  deletions: number;
}

/** True if `path` matches any of the boilerplate rule groups (spec §5.1). */
function isBoilerplate(path: string): boolean {
  const basename = basenameOf(path);
  const segments = segmentsOf(path);

  if (LOCK_FILENAMES.has(basename)) return true;
  if (segments.some((segment) => BUILD_DIR_SEGMENTS.has(segment))) return true;
  if (MINIFIED_SUFFIXES.some((suffix) => basename.endsWith(suffix))) return true;
  if (segments.some((segment) => VENDORED_DIR_SEGMENTS.has(segment))) return true;
  if (
    segments.some((segment) => SNAPSHOT_DIR_SEGMENTS.has(segment)) ||
    basename.endsWith(SNAPSHOT_SUFFIX)
  ) {
    return true;
  }
  if (
    segments.some((segment) => segment === MIGRATION_DIR_SEGMENT) &&
    basename.endsWith(MIGRATION_SUFFIX)
  ) {
    return true;
  }

  return false;
}

/** True if `path` matches any of the wiring rule groups (spec §5.2). */
function isWiring(path: string): boolean {
  const basename = basenameOf(path);

  if (BARREL_BASENAMES.has(basename)) return true;
  if (CONFIG_SUFFIX_PATTERN(basename)) return true;
  if (CONFIG_BASENAME_PREFIXES.some((prefix) => basename.startsWith(prefix))) return true;
  if (MANIFEST_BASENAMES.has(basename)) return true;
  if (path.startsWith(CI_DIR_PREFIX)) return true;
  if (CI_BASENAMES.has(basename) || isDockerComposeBasename(basename)) return true;
  if (basename.startsWith(ENV_BASENAME_PREFIX)) return true;

  return false;
}

/** Classifies a single file path into a `SmartDiffRole`, ignoring size. */
function classifyByPattern(path: string): SmartDiffRole {
  if (isBoilerplate(path)) return 'boilerplate';
  if (isWiring(path)) return 'wiring';
  return 'core';
}

/**
 * Path-only classifier surface — same rules as `classifyFiles`, but without
 * the size-override branch (no additions/deletions to check).
 *
 * Used by the l03 homework `verify` script and any caller that only cares
 * about pattern-based classification.
 */
export function classifyFile(path: string): SmartDiffRole {
  return classifyByPattern(path);
}

/**
 * Classifies each changed file into a `SmartDiffRole`.
 *
 * Priority order (first match wins): boilerplate > wiring > core (default).
 * After pattern classification, a size-override pass reclassifies `core`
 * files with an unfamiliar extension and more than
 * `SIZE_OVERRIDE_THRESHOLD_LINES` changed lines to `boilerplate` (spec §5.4).
 */
export function classifyFiles(
  files: SmartDiffClassifierInput[],
): Map<string, SmartDiffRole> {
  const result = new Map<string, SmartDiffRole>();

  for (const file of files) {
    let role = classifyByPattern(file.path);

    if (
      role === 'core' &&
      !FAMILIAR_EXTENSIONS.has(extensionOf(file.path)) &&
      file.additions + file.deletions > SIZE_OVERRIDE_THRESHOLD_LINES
    ) {
      role = 'boilerplate';
    }

    result.set(file.path, role);
  }

  return result;
}

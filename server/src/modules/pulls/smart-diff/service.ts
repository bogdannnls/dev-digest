/**
 * Smart Diff composer.
 *
 * Pure TS module: `composeSmartDiff` is DB-free and framework-free — it takes
 * plain in-memory data and returns a `SmartDiff` contract value. It only
 * consumes the classifier (T2) and pattern constants (T1). Any DB access
 * needed to gather `ComposerFile[]` / `ComposerFinding[]` for a given PR
 * belongs in a SEPARATE exported function in this same file (T4's job) —
 * never inlined into the composer, so the composer stays trivially unit
 * testable without a database.
 *
 * See spec §6 (algorithm) and §8 (finding_lines duplicate-preservation rule).
 */

import type { SmartDiff, SmartDiffFile, SmartDiffRole } from '@devdigest/shared';
import { classifyFiles } from './classifier.js';
import { TOO_BIG_TOTAL_LINES_THRESHOLD } from './patterns.js';

/** Minimal file shape the composer needs — matches the DB query's projection. */
export interface ComposerFile {
  path: string;
  additions: number;
  deletions: number;
}

/** Minimal finding shape the composer needs — matches the DB query's projection. */
export interface ComposerFinding {
  file: string;
  start_line: number;
}

/** Fixed group order the output always presents, regardless of file membership. */
const GROUP_ROLES: readonly SmartDiffRole[] = ['core', 'wiring', 'boilerplate'];

/**
 * Composes the `SmartDiff` contract value from a PR's changed files and
 * findings. Pure function: same inputs always produce the same output, no
 * I/O, no side effects.
 */
export function composeSmartDiff(files: ComposerFile[], findings: ComposerFinding[]): SmartDiff {
  const roleByPath = classifyFiles(files);

  // Group findings by file — plain loop, no lodash (spec §6.2).
  const findingsByFile = new Map<string, ComposerFinding[]>();
  for (const finding of findings) {
    const bucket = findingsByFile.get(finding.file);
    if (bucket) {
      bucket.push(finding);
    } else {
      findingsByFile.set(finding.file, [finding]);
    }
  }

  const groups = GROUP_ROLES.map((role) => {
    const groupFiles: SmartDiffFile[] = [];

    for (const file of files) {
      if (roleByPath.get(file.path) !== role) continue;

      const fileFindings = findingsByFile.get(file.path) ?? [];
      // Duplicates are preserved intentionally (spec §8) — no dedup here.
      const finding_lines = fileFindings.map((f) => f.start_line).sort((a, b) => a - b);

      groupFiles.push({
        path: file.path,
        pseudocode_summary: null,
        additions: file.additions,
        deletions: file.deletions,
        finding_lines,
      });
    }

    return { role, files: groupFiles };
  });

  const total_lines = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);

  return {
    groups,
    split_suggestion: {
      too_big: total_lines > TOO_BIG_TOTAL_LINES_THRESHOLD,
      total_lines,
      proposed_splits: [],
    },
  };
}

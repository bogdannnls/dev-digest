import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { UnifiedDiff } from '@devdigest/shared';
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';
import type { PRFixtureMeta as PRFixtureMetaT } from '../../vendor/shared/contracts/knowledge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// server/src/modules/agents/eval-fixtures.ts → ../../../test/fixtures/prs
// up 1: modules/, up 2: src/, up 3: server/ → server/test/fixtures/prs
const FIXTURE_DIR = join(__dirname, '../../../test/fixtures/prs');

const PRFixtureFile = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  notes: z.string().optional(),
  diff: z.string().min(1),
});

export interface PRFixtureLoaded {
  meta: PRFixtureMetaT;
  unifiedDiff: UnifiedDiff;
}

let cache: Map<string, PRFixtureLoaded> | null = null;

function loadAll(): Map<string, PRFixtureLoaded> {
  if (cache) return cache;
  const map = new Map<string, PRFixtureLoaded>();
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const raw = readFileSync(join(FIXTURE_DIR, file), 'utf-8');
    const parsed = PRFixtureFile.parse(JSON.parse(raw));
    const unifiedDiff = parseUnifiedDiff(parsed.diff);
    map.set(parsed.id, {
      meta: { id: parsed.id, title: parsed.title, notes: parsed.notes },
      unifiedDiff,
    });
  }
  cache = map;
  return map;
}

export function listFixtures(): PRFixtureMetaT[] {
  const all = Array.from(loadAll().values()).map((f) => f.meta);
  return all.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadFixture(id: string): PRFixtureLoaded | undefined {
  return loadAll().get(id);
}

import { z } from 'zod';
import type { RunEventKind } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { loadPromptTemplate } from '../../platform/prompts.js';
import { resolveFeatureModel } from '../settings/feature-models.js';

const EXTRACTION_SCHEMA = z.object({
  candidates: z.array(
    z.object({
      category: z.string(),
      rule: z.string(),
      evidence_path: z.string(),
      evidence_snippet: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export interface ExtractionCandidate {
  category: string;
  rule: string;
  evidencePath: string;
  evidenceSnippet: string;
  confidence: number;
}

export type EmitFn = (type: RunEventKind, message: string, data?: unknown) => void;

// Config files are NOT returned by getConventionSamples() — it filters them out
// via junk-path rules. We must read them in a separate loop so that explicit
// linting/formatting conventions in these files are visible to the LLM.
const CONFIG_FILES = [
  '.eslintrc.json',
  '.eslintrc.js',
  'eslint.config.js',
  'tsconfig.json',
  'prettier.config.js',
  '.prettierrc',
  '.editorconfig',
];

// Truncate sampled source files to keep the LLM context manageable.
// ~150 lines × ~80 chars — enough to observe patterns without blowing the window.
const MAX_FILE_CHARS = 150 * 80;

export async function extractConventions(
  container: Container,
  workspaceId: string,
  repoId: string,
  repo: { owner: string; name: string; defaultBranch: string },
  emit: EmitFn,
): Promise<ExtractionCandidate[]> {
  // ── 1. Sample config files ───────────────────────────────────────────────
  // Config files live at the repo root and are excluded from getConventionSamples(),
  // so we read them explicitly here.
  emit('info', 'Reading config files...');
  const sampled = new Map<string, string>();

  for (const path of CONFIG_FILES) {
    const content = await readFileContent(container, repo, path);
    if (content !== null) sampled.set(path, content);
  }

  // ── 2. Sample source files ───────────────────────────────────────────────
  emit('info', 'Reading source files...');
  const sourcePaths = await container.repoIntel.getConventionSamples(repoId, 12);

  for (const path of sourcePaths) {
    const content = await readFileContent(container, repo, path);
    if (content !== null) sampled.set(path, content.slice(0, MAX_FILE_CHARS));
  }

  if (sampled.size === 0) {
    emit('result', 'No readable files found', { count: 0 });
    return [];
  }

  // ── 3. Call LLM ──────────────────────────────────────────────────────────
  emit('info', `Analyzing ${sampled.size} files...`);

  const { provider, model } = await resolveFeatureModel(container, workspaceId, 'conventions');
  const llm = await container.llm(provider);

  const systemPrompt = await loadPromptTemplate('conventions-extract.system.md');

  const userContent = [...sampled.entries()]
    .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
    .join('\n\n');

  const result = await llm.completeStructured({
    model,
    schema: EXTRACTION_SCHEMA,
    schemaName: 'ConventionsAnalysis',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Analyze these files and extract coding conventions:\n\n${userContent}`,
      },
    ],
    maxRetries: 2,
  });

  // ── 4. In-memory evidence verification ───────────────────────────────────
  // The LLM only saw the contents we sampled above. Any candidate whose
  // evidence_path was not in our sampled set, or whose evidence_snippet does
  // not appear verbatim in that file's content, is discarded — no disk re-read.
  const rawCandidates = result.data.candidates;
  const verified: ExtractionCandidate[] = [];
  let idx = 0;

  for (const c of rawCandidates) {
    idx += 1;
    emit('tool', `Verifying ${idx}/${rawCandidates.length}...`, {
      total: rawCandidates.length,
      done: idx,
    });

    const fileContent = sampled.get(c.evidence_path);
    if (!fileContent) continue; // path not in sampled set → reject
    if (!fileContent.includes(c.evidence_snippet)) continue; // snippet not verbatim → reject

    verified.push({
      category: c.category,
      rule: c.rule,
      evidencePath: c.evidence_path,
      evidenceSnippet: c.evidence_snippet,
      confidence: c.confidence,
    });
  }

  emit('result', `Found ${verified.length} verified conventions`, { count: verified.length });
  return verified;
}

/**
 * Read a file from the cloned repo via the git adapter.
 * Returns null on any error (file missing, repo not cloned, etc.).
 *
 * GitClient.readFile(repo: RepoRef, path: string): Promise<string>
 * where RepoRef = { owner: string; name: string }.
 */
async function readFileContent(
  container: Container,
  repo: { owner: string; name: string },
  path: string,
): Promise<string | null> {
  try {
    return await container.git.readFile(repo, path);
  } catch {
    return null;
  }
}

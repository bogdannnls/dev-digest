import type { Skill, SkillSource, SkillType } from '@devdigest/shared';
import type { SkillRow } from './repository.js';
import { ValidationError } from '../../platform/errors.js';

export interface ContentChangePatch {
  name?: string;
  description?: string;
  type?: SkillType;
  body?: string;
}

/** True iff a patch changes a content field (name/description/type/body)
 *  relative to the existing row — a content change bumps the version and
 *  snapshots a skill_versions row. Toggling enabled returns false. */
export function isContentChange(
  existing: Pick<SkillRow, 'name' | 'description' | 'type' | 'body'>,
  patch: ContentChangePatch,
): boolean {
  return (
    (patch.name !== undefined && patch.name !== existing.name) ||
    (patch.description !== undefined && patch.description !== existing.description) ||
    (patch.type !== undefined && patch.type !== existing.type) ||
    (patch.body !== undefined && patch.body !== existing.body)
  );
}

/** Map a persisted skill row to the public `Skill` DTO. */
export function toSkillDto(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type as SkillType,
    source: row.source as SkillSource,
    body: row.body,
    enabled: row.enabled,
    version: row.version,
    evidence_files: row.evidenceFiles ?? null,
    attached_context_paths: row.attachedContextPaths ?? null,
  };
}

export interface ParsedImportPayload {
  name: string;
  description: string;
  type: SkillType;
  body: string;
  warnings: string[];
}

const ALLOWED_FRONTMATTER_KEYS = new Set(['name', 'description', 'type', 'enabled']);
const ALLOWED_TYPES = new Set<SkillType>(['rubric', 'convention', 'security', 'custom']);

export function parseSkillMarkdown(
  raw: string,
  filename: string | undefined,
): ParsedImportPayload {
  const warnings: string[] = [];
  const frontmatter: Record<string, string | boolean> = {};
  let body = raw;

  if (raw.startsWith('---\n')) {
    const end = raw.indexOf('\n---\n', 4);
    if (end !== -1) {
      const fmText = raw.slice(4, end);
      body = raw.slice(end + 5);
      for (const line of fmText.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const colon = trimmed.indexOf(':');
        if (colon === -1) {
          warnings.push(`Ignored malformed frontmatter line: ${trimmed}`);
          continue;
        }
        const key = trimmed.slice(0, colon).trim();
        const rawValue = trimmed.slice(colon + 1).trim();
        if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
          warnings.push(`Ignored unknown frontmatter key: ${key}`);
          continue;
        }
        const value = rawValue.replace(/^['"]|['"]$/g, '');
        if (key === 'enabled') {
          frontmatter.enabled = value === 'true';
        } else {
          frontmatter[key] = value;
        }
      }
    }
  }

  let type: SkillType = 'custom';
  const fmType = frontmatter.type;
  if (typeof fmType === 'string' && fmType) {
    if (ALLOWED_TYPES.has(fmType as SkillType)) {
      type = fmType as SkillType;
    } else {
      warnings.push(`Unknown type "${fmType}" — coerced to custom.`);
    }
  }

  body = body.replace(/^\n+/, '').replace(/\s+$/, '');
  if (!body) {
    throw new ValidationError('File body is empty.', { code: 'empty_body' });
  }

  let name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  if (!name) {
    const h1 = body.match(/^#\s+(.+)$/m);
    if (h1?.[1]) name = h1[1].trim();
  }
  if (!name && filename) {
    name = filename.replace(/\.md$/i, '').replace(/[\s_]+/g, '-').trim();
  }
  if (!name) {
    name = 'imported-skill';
  }

  let description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!description) {
    const withoutH1 = body.replace(/^#\s+.+$\n?/m, '').trim();
    const firstPara = withoutH1.split(/\n\s*\n/)[0]?.trim() ?? '';
    description = firstPara.replace(/\.$/, '').slice(0, 200);
  }

  return { name, description, type, body, warnings };
}

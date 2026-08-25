/**
 * `synthesizeBrief` — the one structured LLM call of the Why + Risk Brief
 * synthesis pipeline (SPEC-02). Mirrors `../intent/extract.ts`'s structure:
 * own prompt file, own Zod payload schema, single `completeStructured` call.
 *
 * The model produces ONLY `{ what, why, riskLevel, reviewFocus[] }`
 * (`SynthesizedBriefRaw`, see `./postprocess.ts`) — `risks[]` is NOT part of
 * the model's output schema. `risks[]` is built deterministically afterward
 * by `postprocess.ts` from the PR's already-cached intent risk areas plus
 * the finding set (AC-3, AC-4); asking the model for it would invite a
 * fabricated file:line reference, which is exactly what this feature avoids
 * by design (Non-functional: no `platform/grounding.ts` citation gate needed
 * here because the model is never asked to emit a grounded reference at all).
 *
 * See specs/2026-07-13-why-risk-brief-spec.md AC-10, AC-13, AC-35 and
 * docs/superpowers/plans/2026-07-13-why-risk-brief-plan.md (T5).
 */
import { z } from 'zod';
import { ReviewFocusItem, RiskSeverity } from '@devdigest/shared';
import type { Container } from '../../../platform/container.js';
import { loadPromptTemplate } from '../../../platform/prompts.js';
import type { BriefSynthInput, AssembledFinding } from './assemble-input.js';
import type { SynthesizedBriefRaw } from './postprocess.js';

/**
 * LLM output payload only — NOT the full `PrWhyRiskBrief`. `risks[]`,
 * `model`, `cost`, `computedAt`, and `basedOn` are attached by the caller
 * (job handler / `postprocess.ts`), never produced by the model (AC-10).
 *
 * Deliberately a plain (non-`.strict()`) `z.object`: if the model emits an
 * extra `risks` key alongside the required fields, the default Zod object
 * behavior silently strips it from `.data` rather than throwing — this is a
 * model OUTPUT schema (not a request-body boundary), so tolerating and
 * discarding extra keys is the correct posture, not a strict-rejection one.
 * Either way, a `risks` field never survives into `SynthesizeBriefResult`.
 */
const BRIEF_SYNTH_PAYLOAD_SCHEMA = z.object({
  what: z.string().min(1),
  why: z.string().min(1),
  riskLevel: RiskSeverity,
  reviewFocus: z.array(ReviewFocusItem),
});

export interface SynthesizeBriefResult {
  /** Raw model output only, no deterministic post-processing applied yet (that's `postprocess.ts`, T12). */
  data: SynthesizedBriefRaw;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
}

/** Build the deterministic user message from T3's already-assembled input. */
function buildUserMessage(input: BriefSynthInput): string {
  const sections = [
    `## Intent\nGoal: ${input.intent.goal}\nIn scope:\n${bulletList(input.intent.inScope)}\nOut of scope:\n${bulletList(input.intent.outOfScope)}\nRisk areas:\n${bulletList(input.intent.riskAreas.map((r) => `[${r.icon}] ${r.label}`))}`,
    `## Findings (non-dismissed, latest review)\n${formatFindings(input.findings)}`,
    `## Blast radius\nChanged symbols:\n${bulletList(input.blast.changedSymbols.map((s) => `${s.kind} ${s.name} (${s.file})`))}\nCallers:\n${bulletList(input.blast.callers.map((c) => `${c.symbol} (${c.file}) -> via ${c.viaSymbol}`))}\nImpacted endpoints:\n${bulletList(input.blast.impactedEndpoints)}`,
    `## Diff stats\n${formatDiffStats(input)}`,
    `## Attached specs\n${bulletList(input.attachedSpecs.map((s) => s.title))}`,
  ];

  return sections.join('\n\n');
}

function bulletList(items: readonly string[]): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join('\n') : '(none)';
}

function formatFindings(findings: readonly AssembledFinding[]): string {
  if (findings.length === 0) return '(none)';
  return findings
    .map(
      (f) =>
        `- id="${f.id}" severity=${f.severity} category=${f.category} file=${f.file}:${f.startLine}-${f.endLine} title="${f.title}"\n  rationale: ${f.rationale}`,
    )
    .join('\n');
}

function formatDiffStats(input: BriefSynthInput): string {
  const groups = input.diffStats.groups
    .map((g) => `- ${g.role}: ${g.files.map((f) => `${f.path} (+${f.additions}/-${f.deletions})`).join(', ')}`)
    .join('\n');
  const split = input.diffStats.split_suggestion;
  return `${groups || '(no files)'}\nTotal lines: ${split.total_lines}${split.too_big ? ' (flagged too big)' : ''}`;
}

export async function synthesizeBrief(
  container: Container,
  workspaceId: string,
  input: BriefSynthInput,
): Promise<SynthesizeBriefResult> {
  const { provider, model } = await container.resolveFeatureModel(workspaceId, 'risk_brief');
  const llm = await container.llm(provider);

  const systemPrompt = await loadPromptTemplate('brief-synth.system.md');
  const userMessage = buildUserMessage(input);

  const result = await llm.completeStructured({
    model,
    schema: BRIEF_SYNTH_PAYLOAD_SCHEMA,
    schemaName: 'BriefSynthPayload',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    maxRetries: 2,
  });

  // Defensive re-parse (mirrors extract.ts's `PrIntentDto.parse(...)`
  // re-validation) — belt-and-suspenders against a schema mismatch anywhere
  // upstream, and the boundary that guarantees `risks` never survives even
  // if a non-compliant model response smuggled one through.
  const data = BRIEF_SYNTH_PAYLOAD_SCHEMA.parse(result.data);

  return {
    data,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: result.costUsd ?? 0,
    model: result.model,
  };
}

/**
 * `extractIntent` — the pure LLM call of the Intent Layer pipeline.
 * See docs/superpowers/specs/2026-07-04-intent-layer-design.md §8.4.
 */
import { z } from 'zod';
import { PrIntentDto, RiskAreaIcon } from '@devdigest/shared';
import type { Container } from '../../../platform/container.js';
import { loadPromptTemplate } from '../../../platform/prompts.js';
import { toReferenceDto, type CollectedReference } from './types.js';

/**
 * LLM output payload only — NOT the full `PrIntentDto`. `references`, `model`,
 * `cost`, and `computedAt` are attached by the caller (job handler), not
 * produced by the model.
 */
const INTENT_PAYLOAD_SCHEMA = z.object({
  goal: z.string().min(1),
  inScope: z.array(z.string()).max(20),
  outOfScope: z.array(z.string()).max(20),
  riskAreas: z
    .array(
      z.object({
        icon: RiskAreaIcon,
        label: z.string().min(1).max(40),
      }),
    )
    .max(3),
});

export interface ExtractIntentInput {
  title: string;
  body: string;
  diffSummary: string;
  references: CollectedReference[];
}

export interface ExtractIntentResult {
  dto: PrIntentDto;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
}

/** Build the deterministic user message per spec §8.4. */
function buildUserMessage(input: ExtractIntentInput): string {
  const sections = [
    `## Title\n${input.title}`,
    `## Body\n${input.body || '(empty)'}`,
    `## Files (clipped diff)\n${input.diffSummary}`,
  ];

  const okReferences = input.references.filter((r) => r.status === 'ok');
  const referenceBlocks = okReferences
    .map(
      (r) =>
        `<external_reference kind="${r.kind}" id="${r.id}" source="${referenceSource(r)}">\n${r.body ?? ''}\n</external_reference>`,
    )
    .join('\n');

  sections.push(`## External references\n${referenceBlocks}`);

  return sections.join('\n\n');
}

/**
 * Best-effort "source" label for the `<external_reference>` tag. `CollectedReference`
 * (spec §6.3) doesn't carry a dedicated source/host field, so this derives a
 * reasonable label from `kind` — good enough for the LLM's own context framing.
 */
function referenceSource(r: CollectedReference): string {
  switch (r.kind) {
    case 'github_issue':
      return 'github.com';
    case 'jira':
      return 'jira';
    case 'linear':
      return 'linear';
    case 'url':
      return 'url';
    default:
      return r.kind;
  }
}

export async function extractIntent(
  container: Container,
  workspaceId: string,
  input: ExtractIntentInput,
): Promise<ExtractIntentResult> {
  const { provider, model } = await container.resolveFeatureModel(workspaceId, 'review_intent');
  const llm = await container.llm(provider);

  const systemPrompt = await loadPromptTemplate('intent-extractor.system.md');
  const userMessage = buildUserMessage(input);

  const result = await llm.completeStructured({
    model,
    schema: INTENT_PAYLOAD_SCHEMA,
    schemaName: 'PrIntentPayload',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    maxRetries: 2,
  });

  const dto = PrIntentDto.parse({
    ...result.data,
    references: input.references.map(toReferenceDto),
    model: result.model,
    cost: {
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      usd: result.costUsd ?? 0,
    },
    computedAt: new Date().toISOString(),
  });

  return {
    dto,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: result.costUsd ?? 0,
    model: result.model,
  };
}

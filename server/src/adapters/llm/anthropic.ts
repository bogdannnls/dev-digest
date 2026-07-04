import Anthropic from '@anthropic-ai/sdk';
import PQueue from 'p-queue';
import type {
  LLMProvider,
  ModelInfo,
  CompletionRequest,
  CompletionResult,
  StructuredRequest,
  StructuredResult,
  ChatMessage,
} from '@devdigest/shared';
import { withRetry, withIdleTimeout } from '../../platform/resilience.js';
import { toJsonSchema, parseWithRepair } from '../../platform/structured.js';
import { estimateCost } from './pricing.js';
import { ExternalServiceError } from '../../platform/errors.js';

/**
 * Idle-timeout on the stream (not total wall-clock). If Anthropic sends no bytes
 * for this long the request is treated as hung and aborted. Total generation
 * time is unbounded — a long-but-progressing stream never trips this.
 */
const IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Per-key concurrency ceiling. When N reviewers fire against the same Anthropic
 * key, requests beyond this limit queue LOCALLY (before the HTTP call is made)
 * instead of queuing at Anthropic's rate-limit gate — where a queued request
 * holds an open connection with no bytes flowing, tripping withIdleTimeout as
 * if the stream were hung. Serializing on our side keeps TTFB tight.
 *
 * Override with the ANTHROPIC_MAX_CONCURRENCY env var if a Tier-3+ key can push
 * higher without queuing.
 */
const DEFAULT_CONCURRENCY = 3;

/**
 * Claude 4.x+ models (Opus 4.x, Sonnet 4.x, Haiku 4.x) and the Fable family
 * reject a custom `temperature` and respond with 400 `temperature is deprecated
 * for this model`. Legacy claude-3-* still accepts it. Mirrors the
 * isReasoningModel pattern in openai.ts.
 */
function rejectsTemperature(model: string): boolean {
  return /^claude-(opus|sonnet|haiku)-[4-9]|^claude-fable-/.test(model);
}

/** Anthropic has no embeddings API; embeddings come from the OpenAI Embedder. */
function splitSystem(messages: ChatMessage[]): {
  system: string;
  rest: Anthropic.MessageParam[];
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  return { system, rest };
}

/**
 * Anthropic LLMProvider.
 * - listModels: dynamic via GET /models.
 * - completeStructured: FORCED tool-use (single tool, input_schema = our JSON
 *   schema, tool_choice forces it), parse tool_use.input, Zod validate + reprompt.
 * - embed: NOT supported (throws) — use the OpenAI Embedder for vectors.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic' as const;
  private client: Anthropic;
  private queue: PQueue;

  constructor(apiKey: string, opts: { concurrency?: number } = {}) {
    this.client = new Anthropic({ apiKey });
    const envN = Number(process.env.ANTHROPIC_MAX_CONCURRENCY);
    const concurrency =
      opts.concurrency ??
      (Number.isFinite(envN) && envN > 0 ? envN : DEFAULT_CONCURRENCY);
    this.queue = new PQueue({ concurrency });
  }

  async listModels(): Promise<ModelInfo[]> {
    return withRetry(async () => {
      // SDK 0.33 exposes models.list()
      const res = await this.client.models.list();
      return res.data.map((m) => ({
        id: m.id,
        provider: 'anthropic' as const,
        label: m.display_name,
      }));
    });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // withRetry wraps the queue slot (not the other way around) so a 429/5xx
    // backoff sleep doesn't hold a concurrency slot while it waits.
    return withRetry(() => this.gated(() => this.doComplete(req)));
  }

  /** Serialize the HTTP-touching work onto the per-key queue. */
  private gated<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.add(fn) as Promise<T>;
  }

  private async doComplete(req: CompletionRequest): Promise<CompletionResult> {
    const { system, rest } = splitSystem(req.messages);
    const idleMs = req.timeoutMs ?? IDLE_TIMEOUT_MS;
    const stream = this.client.messages.stream({
      model: req.model,
      system: system || undefined,
      messages: rest,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(rejectsTemperature(req.model) ? {} : { temperature: req.temperature ?? 0.2 }),
    });
    // Drain the SSE with an idle-timer that resets on every event. `finalMessage`
    // below throws if the stream ended prematurely, so we don't need to handle
    // partial state here.
    for await (const _event of withIdleTimeout(stream, idleMs, () => stream.controller.abort())) {
      // no-op: we only need the assembled Message from finalMessage()
    }
    const res = await stream.finalMessage();
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const tokensIn = res.usage.input_tokens;
    const tokensOut = res.usage.output_tokens;
    return {
      text,
      model: req.model,
      tokensIn,
      tokensOut,
      costUsd: estimateCost(req.model, tokensIn, tokensOut),
    };
  }

  async completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const jsonSchema = toJsonSchema(req.schema, req.schemaName);
    const toolName = req.schemaName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const maxRetries = req.maxRetries ?? 2;
    const { system, rest } = splitSystem(req.messages);
    const messages: Anthropic.MessageParam[] = [...rest];
    let tokensIn = 0;
    let tokensOut = 0;
    let lastRaw = '';

    const idleMs = req.timeoutMs ?? IDLE_TIMEOUT_MS;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const res = await withRetry(() =>
        this.gated(async () => {
          const stream = this.client.messages.stream({
            model: req.model,
            system: system || undefined,
            messages,
            max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...(rejectsTemperature(req.model) ? {} : { temperature: req.temperature ?? 0 }),
            tools: [
              {
                name: toolName,
                description: `Return the result as ${req.schemaName}.`,
                input_schema: jsonSchema.schema as Anthropic.Tool.InputSchema,
              },
            ],
            tool_choice: { type: 'tool', name: toolName },
          });
          // Drain events under the idle-timer. `input_json_delta` chunks assemble
          // into the tool's `input`; the SDK reconstructs the final ToolUseBlock
          // for us — we only iterate to keep the stream alive.
          for await (const _event of withIdleTimeout(stream, idleMs, () =>
            stream.controller.abort(),
          )) {
            // no-op
          }
          return stream.finalMessage();
        }),
      );
      tokensIn += res.usage.input_tokens;
      tokensOut += res.usage.output_tokens;

      const toolUse = res.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );
      lastRaw = toolUse ? JSON.stringify(toolUse.input) : '';

      const parsed = parseWithRepair(req.schema, lastRaw);
      if (parsed.ok) {
        return {
          data: parsed.data,
          model: req.model,
          tokensIn,
          tokensOut,
          costUsd: estimateCost(req.model, tokensIn, tokensOut),
          raw: lastRaw,
          attempts: attempt,
        };
      }
      messages.push({ role: 'assistant', content: res.content });
      // Anthropic requires the message AFTER a `tool_use` to contain a matching
      // `tool_result`. Sending plain text triggers 400 "tool_use ids were found
      // without tool_result blocks". `is_error: true` tells the model the tool
      // call needs correction (mirrors the OpenAI-side reprompt semantics).
      messages.push({
        role: 'user',
        content: toolUse
          ? [
              {
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: parsed.repromptMessage,
                is_error: true,
              },
            ]
          : parsed.repromptMessage,
      });
    }

    throw new ExternalServiceError('Anthropic structured output failed schema validation', {
      raw: lastRaw,
    });
  }

  async embed(): Promise<number[][]> {
    throw new ExternalServiceError(
      'Anthropic does not provide embeddings; use the OpenAI Embedder.',
    );
  }
}

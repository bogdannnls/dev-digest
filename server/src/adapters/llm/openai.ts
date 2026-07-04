import OpenAI from 'openai';
import PQueue from 'p-queue';
import type {
  LLMProvider,
  ModelInfo,
  CompletionRequest,
  CompletionResult,
  StructuredRequest,
  StructuredResult,
} from '@devdigest/shared';
import { withRetry, withIdleTimeout, withTimeout } from '../../platform/resilience.js';
import { toJsonSchema, parseWithRepair } from '../../platform/structured.js';
import { estimateCost } from './pricing.js';
import { ExternalServiceError } from '../../platform/errors.js';

/**
 * Idle-timeout on the stream (not total wall-clock). If OpenAI sends no chunks
 * for this long the request is treated as hung and aborted. Total generation
 * time is unbounded — a long-but-progressing stream never trips this.
 */
const IDLE_TIMEOUT_MS = 60_000;
/** Total-timeout for the (non-streaming) embeddings endpoint. */
const EMBED_TIMEOUT_MS = 60_000;
const EMBED_MODEL = 'text-embedding-3-small';

/**
 * Per-key concurrency ceiling. Same rationale as AnthropicProvider — serialize
 * on our side so requests don't queue at OpenAI's rate-limit gate with an open
 * connection and no bytes flowing (which would trip withIdleTimeout).
 *
 * OpenAI limits are usually higher than Anthropic's, so the default is more
 * generous. Override with the OPENAI_MAX_CONCURRENCY env var.
 */
const DEFAULT_CONCURRENCY = 5;

/**
 * GPT-5 and the o-series reasoning models reject a custom `temperature` (only
 * the default is allowed) and use `max_completion_tokens` instead of
 * `max_tokens`. Detect them so we can omit/remap those params.
 */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o1|o3|o4)/.test(model);
}

/** Build the temperature + token-cap params appropriate for the given model. */
function tuningParams(
  model: string,
  temperature: number | undefined,
  maxTokens: number | undefined,
): Record<string, number> {
  if (isReasoningModel(model)) {
    return maxTokens ? { max_completion_tokens: maxTokens } : {};
  }
  const p: Record<string, number> = { temperature: temperature ?? 0 };
  if (maxTokens) p.max_tokens = maxTokens;
  return p;
}

/**
 * OpenAI LLMProvider.
 * - listModels: dynamic via GET /models (not hardcoded).
 * - completeStructured: response_format json_schema + Zod validate + reprompt.
 * - embed: text-embedding-3-small (1536 dims).
 */
export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai' as const;
  private client: OpenAI;
  private queue: PQueue;

  constructor(apiKey: string, opts: { concurrency?: number } = {}) {
    this.client = new OpenAI({ apiKey });
    const envN = Number(process.env.OPENAI_MAX_CONCURRENCY);
    const concurrency =
      opts.concurrency ??
      (Number.isFinite(envN) && envN > 0 ? envN : DEFAULT_CONCURRENCY);
    this.queue = new PQueue({ concurrency });
  }

  /** Serialize the HTTP-touching work onto the per-key queue. */
  private gated<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.add(fn) as Promise<T>;
  }

  async listModels(): Promise<ModelInfo[]> {
    return withRetry(async () => {
      const res = await this.client.models.list();
      return res.data
        .filter((m) => m.id.startsWith('gpt') || m.id.includes('o1') || m.id.includes('o3'))
        .map((m) => ({ id: m.id, provider: 'openai' as const, created: m.created }));
    });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // withRetry wraps the queue slot (not the other way around) so a 429/5xx
    // backoff sleep doesn't hold a concurrency slot while it waits.
    return withRetry(() => this.gated(() => this.doComplete(req)));
  }

  private async doComplete(req: CompletionRequest): Promise<CompletionResult> {
    const idleMs = req.timeoutMs ?? IDLE_TIMEOUT_MS;
    const stream = this.client.beta.chat.completions.stream({
      model: req.model,
      messages: req.messages,
      ...tuningParams(req.model, req.temperature ?? 0.2, req.maxTokens),
    });
    for await (const _chunk of withIdleTimeout(stream, idleMs, () => stream.abort())) {
      // no-op: only need finalChatCompletion() below
    }
    const res = await stream.finalChatCompletion();
    const text = res.choices?.[0]?.message?.content ?? '';
    const tokensIn = res.usage?.prompt_tokens ?? 0;
    const tokensOut = res.usage?.completion_tokens ?? 0;
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
    const maxRetries = req.maxRetries ?? 2;
    const messages = [...req.messages];
    let tokensIn = 0;
    let tokensOut = 0;
    let lastRaw = '';

    const idleMs = req.timeoutMs ?? IDLE_TIMEOUT_MS;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const res = await withRetry(() =>
        this.gated(async () => {
          const stream = this.client.beta.chat.completions.stream({
            model: req.model,
            messages,
            ...tuningParams(req.model, req.temperature, req.maxTokens),
            response_format: {
              type: 'json_schema',
              json_schema: { name: req.schemaName, schema: jsonSchema.schema, strict: true },
            },
          });
          for await (const _chunk of withIdleTimeout(stream, idleMs, () => stream.abort())) {
            // no-op
          }
          return stream.finalChatCompletion();
        }),
      );
      lastRaw = res.choices?.[0]?.message?.content ?? '';
      tokensIn += res.usage?.prompt_tokens ?? 0;
      tokensOut += res.usage?.completion_tokens ?? 0;

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
      // reprompt-on-error
      messages.push({ role: 'assistant', content: lastRaw });
      messages.push({ role: 'user', content: parsed.repromptMessage });
    }

    throw new ExternalServiceError('OpenAI structured output failed schema validation', {
      raw: lastRaw,
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return withRetry(async () => {
      const res = await withTimeout(
        this.client.embeddings.create({ model: EMBED_MODEL, input: texts }),
        EMBED_TIMEOUT_MS,
      );
      return res.data.map((d) => d.embedding);
    });
  }
}

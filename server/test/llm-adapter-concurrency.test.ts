import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from '../src/adapters/llm/anthropic.js';
import { OpenAIProvider } from '../src/adapters/llm/openai.js';

/**
 * These tests verify the per-key concurrency gate (option C in the timeout
 * design discussion): with N reviewers hitting the same provider instance,
 * only `concurrency` of them should have an open HTTP request to the vendor
 * at any moment. Requests beyond that queue LOCALLY, before the stream is
 * created — which is the whole point: a request queued at Anthropic's
 * rate-limit gate holds an idle connection and trips withIdleTimeout as if
 * the stream were hung.
 */

/** Fake stream that resolves after `delayMs`, tracking concurrent in-flight count. */
function makeConcurrencyTracker() {
  let inFlight = 0;
  let peak = 0;
  const controller = { abort: vi.fn() };

  function fakeStreamFactory(delayMs = 20) {
    inFlight++;
    peak = Math.max(peak, inFlight);
    // Yield an event immediately so withIdleTimeout doesn't trip during the delay.
    const events = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_stop' },
    ];
    return {
      controller,
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
      async finalMessage() {
        await new Promise((r) => setTimeout(r, delayMs));
        inFlight--;
        return {
          content: [{ type: 'text' as const, text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
      // OpenAI shape
      abort: vi.fn(),
      async finalChatCompletion() {
        await new Promise((r) => setTimeout(r, delayMs));
        inFlight--;
        return {
          choices: [{ message: { content: 'ok', role: 'assistant' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    };
  }

  return {
    factory: fakeStreamFactory,
    get peak() {
      return peak;
    },
  };
}

describe('AnthropicProvider — per-key concurrency', () => {
  it('serializes concurrent complete() calls to `concurrency` in-flight requests', async () => {
    const provider = new AnthropicProvider('sk-test', { concurrency: 2 });
    const tracker = makeConcurrencyTracker();
    // Return the SAME fake for each call (each call gets its own in-flight/finalMessage delay).
    (provider as unknown as { client: unknown }).client = {
      messages: { stream: vi.fn(() => tracker.factory(30)) },
    };

    // Fire 5 concurrent calls. With concurrency=2, peak in-flight should be 2.
    await Promise.all(
      Array.from({ length: 5 }, () =>
        provider.complete({
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    );

    expect(tracker.peak).toBe(2);
  });

  it('honors ANTHROPIC_MAX_CONCURRENCY when no explicit override is passed', async () => {
    const prev = process.env.ANTHROPIC_MAX_CONCURRENCY;
    process.env.ANTHROPIC_MAX_CONCURRENCY = '1';
    try {
      const provider = new AnthropicProvider('sk-test');
      const tracker = makeConcurrencyTracker();
      (provider as unknown as { client: unknown }).client = {
        messages: { stream: vi.fn(() => tracker.factory(20)) },
      };
      await Promise.all(
        Array.from({ length: 3 }, () =>
          provider.complete({
            model: 'claude-opus-4-7',
            messages: [{ role: 'user', content: 'hi' }],
          }),
        ),
      );
      expect(tracker.peak).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_MAX_CONCURRENCY;
      else process.env.ANTHROPIC_MAX_CONCURRENCY = prev;
    }
  });
});

describe('OpenAIProvider — per-key concurrency', () => {
  it('serializes concurrent complete() calls to `concurrency` in-flight requests', async () => {
    const provider = new OpenAIProvider('sk-test', { concurrency: 2 });
    const tracker = makeConcurrencyTracker();
    (provider as unknown as { client: unknown }).client = {
      beta: { chat: { completions: { stream: vi.fn(() => tracker.factory(30)) } } },
    };

    await Promise.all(
      Array.from({ length: 5 }, () =>
        provider.complete({
          model: 'gpt-4.1',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      ),
    );

    expect(tracker.peak).toBe(2);
  });
});

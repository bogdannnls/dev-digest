import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from '../src/adapters/llm/anthropic.js';
import { OpenAIProvider } from '../src/adapters/llm/openai.js';
import { z } from 'zod';

/**
 * Small helpers that build a fake SDK stream with the same public surface as
 * Anthropic's MessageStream / OpenAI's ChatCompletionStream: AsyncIterable +
 * final*(). We assert the adapter drains the stream first, then awaits the
 * final*() promise to assemble the result — the fake counts iterations to
 * prove the drain actually happened.
 */

function fakeAnthropicStream(opts: { text: string; usage: { input: number; output: number } }) {
  const events = [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: opts.text } },
    { type: 'message_stop' },
  ];
  let iterated = 0;
  const abort = vi.fn();
  return {
    controller: { abort },
    async *[Symbol.asyncIterator]() {
      for (const e of events) {
        iterated++;
        yield e;
      }
    },
    async finalMessage() {
      return {
        content: [{ type: 'text' as const, text: opts.text }],
        usage: { input_tokens: opts.usage.input, output_tokens: opts.usage.output },
      };
    },
    get iterated() {
      return iterated;
    },
    _abort: abort,
  };
}

function fakeOpenAIStream(opts: { content: string; usage: { input: number; output: number } }) {
  const chunks = [
    { choices: [{ delta: { content: opts.content } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];
  let iterated = 0;
  const abort = vi.fn();
  return {
    abort,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        iterated++;
        yield c;
      }
    },
    async finalChatCompletion() {
      return {
        choices: [{ message: { content: opts.content, role: 'assistant' } }],
        usage: { prompt_tokens: opts.usage.input, completion_tokens: opts.usage.output },
      };
    },
    get iterated() {
      return iterated;
    },
    _abort: abort,
  };
}

describe('AnthropicProvider — streaming complete()', () => {
  it('drains the stream, then assembles text + usage from finalMessage()', async () => {
    const provider = new AnthropicProvider('sk-test');
    const fake = fakeAnthropicStream({ text: 'ping pong', usage: { input: 7, output: 3 } });
    // Inject: replace the SDK client with a mock exposing messages.stream().
    (provider as unknown as { client: unknown }).client = {
      messages: { stream: vi.fn(() => fake) },
    };

    const res = await provider.complete({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.text).toBe('ping pong');
    expect(res.tokensIn).toBe(7);
    expect(res.tokensOut).toBe(3);
    expect(fake.iterated).toBe(2); // proves drain ran before finalMessage()
    expect(fake._abort).not.toHaveBeenCalled();
  });
});

describe('AnthropicProvider — streaming completeStructured()', () => {
  it('drains the stream and returns parsed tool input from the final tool_use block', async () => {
    const provider = new AnthropicProvider('sk-test');
    const schema = z.object({ ok: z.boolean(), n: z.number() });
    const toolInput = { ok: true, n: 42 };
    const fake = {
      controller: { abort: vi.fn() },
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_start' };
        yield {
          type: 'content_block_delta',
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
        };
        yield { type: 'message_stop' };
      },
      async finalMessage() {
        return {
          content: [{ type: 'tool_use' as const, id: 't1', name: 'Payload', input: toolInput }],
          usage: { input_tokens: 12, output_tokens: 8 },
        };
      },
    };
    (provider as unknown as { client: unknown }).client = {
      messages: { stream: vi.fn(() => fake) },
    };

    const res = await provider.completeStructured({
      model: 'claude-opus-4-7',
      schema,
      schemaName: 'Payload',
      messages: [{ role: 'user', content: 'produce payload' }],
    });

    expect(res.data).toEqual(toolInput);
    expect(res.tokensIn).toBe(12);
    expect(res.tokensOut).toBe(8);
    expect(res.attempts).toBe(1);
  });
});

describe('OpenAIProvider — streaming complete()', () => {
  it('drains the stream, then assembles text + usage from finalChatCompletion()', async () => {
    const provider = new OpenAIProvider('sk-test');
    const fake = fakeOpenAIStream({ content: 'hello there', usage: { input: 5, output: 4 } });
    (provider as unknown as { client: unknown }).client = {
      beta: { chat: { completions: { stream: vi.fn(() => fake) } } },
    };

    const res = await provider.complete({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.text).toBe('hello there');
    expect(res.tokensIn).toBe(5);
    expect(res.tokensOut).toBe(4);
    expect(fake.iterated).toBe(2);
    expect(fake._abort).not.toHaveBeenCalled();
  });
});

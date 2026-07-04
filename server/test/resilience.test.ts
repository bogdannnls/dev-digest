import { describe, it, expect, vi } from 'vitest';
import { withIdleTimeout, TimeoutError } from '../src/platform/resilience.js';

/** Fake stream: yields `n` chunks with `gapMs` between them. */
async function* pacedStream(n: number, gapMs: number): AsyncGenerator<number> {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, gapMs));
    yield i;
  }
}

/** Fake stream that never yields until aborted. */
function hungStream(signal: AbortSignal): AsyncIterable<number> {
  return {
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      yield 0;
    },
  };
}

describe('withIdleTimeout', () => {
  it('passes chunks through when the stream stays live', async () => {
    const seen: number[] = [];
    const onIdle = vi.fn();
    for await (const n of withIdleTimeout(pacedStream(3, 10), 100, onIdle)) {
      seen.push(n);
    }
    expect(seen).toEqual([0, 1, 2]);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('does NOT trip during a slow-but-live stream', async () => {
    // idleMs=50, chunk every 20ms for 5 chunks → total 100ms, no idle stretch > 50ms
    const seen: number[] = [];
    const onIdle = vi.fn();
    for await (const n of withIdleTimeout(pacedStream(5, 20), 50, onIdle)) {
      seen.push(n);
    }
    expect(seen).toHaveLength(5);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('calls onIdle and throws TimeoutError when no chunk arrives before idleMs', async () => {
    const ctrl = new AbortController();
    const onIdle = vi.fn(() => ctrl.abort());
    await expect(
      (async () => {
        for await (const _ of withIdleTimeout(hungStream(ctrl.signal), 40, onIdle)) {
          // never
        }
      })(),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('resets the idle timer on every chunk (long stream, short gaps)', async () => {
    // If the timer were total-wall-clock (60ms) this would fail — the stream
    // runs for 100ms. But each gap (20ms) is under idleMs (60ms), so no trip.
    const seen: number[] = [];
    const onIdle = vi.fn();
    for await (const n of withIdleTimeout(pacedStream(5, 20), 60, onIdle)) {
      seen.push(n);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

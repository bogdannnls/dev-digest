import { describe, expect, it } from 'vitest';
import type { DevDigestPort } from '../domain/ports.js';
import { NotImplementedError } from '../platform/errors.js';
import { getBlastRadius } from './get-blast-radius.js';

const NOT_IMPLEMENTED_MESSAGE =
  'get_blast_radius is not implemented yet — planned as course slice C. Call list_agents or run_agent_on_pr in the meantime.';

/**
 * Proxy-backed port that records every method access. The stub must not touch
 * the port at all (rule A1 — zero I/O for a stub); any access is recorded so
 * the test can assert an empty call log.
 */
function trackingPort(): { port: DevDigestPort; calls: string[] } {
  const calls: string[] = [];
  const port = new Proxy(
    {},
    {
      get(_target, prop) {
        return (..._args: unknown[]) => {
          calls.push(String(prop));
          return Promise.reject(
            new Error(`unexpected port call: ${String(prop)}`),
          );
        };
      },
    },
  ) as unknown as DevDigestPort;
  return { port, calls };
}

const SAMPLE_INPUT = { repo: 'letyshops/dev-digest', pr: 42 } as const;

describe('getBlastRadius (stub)', () => {
  it('rejects with NotImplementedError carrying the exact literal message', async () => {
    const { port } = trackingPort();
    await expect(getBlastRadius(port, SAMPLE_INPUT)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(getBlastRadius(port, SAMPLE_INPUT)).rejects.toThrow(
      NOT_IMPLEMENTED_MESSAGE,
    );
  });

  it('performs zero port calls (rule A1)', async () => {
    const { port, calls } = trackingPort();
    await expect(getBlastRadius(port, SAMPLE_INPUT)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    expect(calls).toEqual([]);
  });

  it('thrown error toMcpErrorContent() returns the isError shape with the literal text', async () => {
    const { port } = trackingPort();
    let caught: unknown;
    try {
      await getBlastRadius(port, SAMPLE_INPUT);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotImplementedError);
    expect((caught as NotImplementedError).toMcpErrorContent()).toEqual({
      isError: true,
      content: [{ type: 'text', text: NOT_IMPLEMENTED_MESSAGE }],
    });
  });
});

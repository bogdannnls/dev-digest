/**
 * `get_blast_radius` — course slice C stub.
 *
 * Inputs are accepted to fix the tool signature (so callers do not need to
 * change once the real implementation lands) but never consulted; this
 * service performs zero `DevDigestPort` calls and always throws
 * `NotImplementedError`. T9's tool handler catches the typed error and
 * converts it to MCP `isError: true` content via
 * `NotImplementedError.toMcpErrorContent()`.
 */

import type { DevDigestPort } from '../domain/ports.js';
import { NotImplementedError } from '../platform/errors.js';

export interface GetBlastRadiusInput {
  repo: string;
  pr: number;
}

export async function getBlastRadius(
  _port: DevDigestPort,
  _input: GetBlastRadiusInput,
): Promise<never> {
  throw new NotImplementedError();
}

/**
 * DI seam (rule A5) — the only file in `mcp/src/` allowed to construct
 * `HttpDevDigestAdapter` (tests aside — tests are outside the app's
 * dependency graph and may construct adapters directly).
 */

import type { DevDigestPort } from '../domain/ports.js';
import { HttpDevDigestAdapter } from '../adapters/http-devdigest.js';

export interface Container {
  devDigest: DevDigestPort;
}

export function createContainer(env: NodeJS.ProcessEnv): Container {
  return {
    devDigest: new HttpDevDigestAdapter(env),
  };
}

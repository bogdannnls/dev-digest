/* api.ts — typed fetch client for the F1 Fastify engine (localhost:3001).
   All hooks build on `apiFetch`. Errors are normalized to ApiError so the
   error-UX taxonomy (toast/inline/full-screen) can branch on status. */

import {
  PRFixtureMeta,
  SkillsEvalResult,
  EvalCase,
  EvalBatchRecord,
  EvalBatchDetail,
  EvalRunComparison,
  EvalDashboardIndex,
  EvalDashboard,
} from "@devdigest/shared";
import type { EvalCaseManualInput } from "@devdigest/shared";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        // Only declare a JSON body when one is actually sent — otherwise a
        // body-less POST/PUT (e.g. tour generate, refresh, reindex) trips
        // Fastify's "Body cannot be empty when content-type is application/json".
        ...(init?.body != null && !(init.body instanceof FormData)
          ? { "content-type": "application/json" }
          : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    // network failure / API down → full-screen error candidate
    throw new ApiError(
      `Cannot reach the DevDigest engine at ${API_BASE}. Is the API running?`,
      0,
      "network_error",
      e
    );
  }

  if (!res.ok) {
    let code: string | undefined;
    let message = `${res.status} ${res.statusText}`;
    let details: unknown;
    try {
      const body = await res.json();
      if (body?.error) {
        code = body.error.code;
        message = body.error.message ?? message;
        details = body.error.details;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status, code, details);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    apiFetch<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => apiFetch<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return apiFetch<T>(path, { method: "POST", body: fd });
  },

  async getEvalFixtures(): Promise<PRFixtureMeta[]> {
    const data = await apiFetch<unknown>('/agents/eval-fixtures');
    return PRFixtureMeta.array().parse(data);
  },

  async runSkillsEval(agentId: string, fixtureId: string): Promise<SkillsEvalResult> {
    const data = await apiFetch<unknown>(`/agents/${agentId}/skills-eval`, {
      method: 'POST',
      body: JSON.stringify({ fixture_id: fixtureId }),
    });
    return SkillsEvalResult.parse(data);
  },

  // ---------------------------------------------------------------------
  // Eval Pipeline (L06) — contract section 4.
  // ---------------------------------------------------------------------

  async getEvalCases(agentId: string): Promise<EvalCase[]> {
    const data = await apiFetch<unknown>(`/agents/${agentId}/eval-cases`);
    return EvalCase.array().parse(data);
  },

  /** Idempotent: re-clicking the same finding returns the existing case with 200.
   *  Not agent-scoped (v1.4 contract change): the server derives the owning
   *  agent from finding -> review.agent_id. */
  async createEvalCaseFromFinding(findingId: string): Promise<EvalCase> {
    const data = await apiFetch<unknown>('/eval-cases/from-finding', {
      method: 'POST',
      body: JSON.stringify({ finding_id: findingId }),
    });
    return EvalCase.parse(data);
  },

  async createEvalCase(agentId: string, input: EvalCaseManualInput): Promise<EvalCase> {
    const data = await apiFetch<unknown>(`/agents/${agentId}/eval-cases`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return EvalCase.parse(data);
  },

  async updateEvalCase(agentId: string, caseId: string, input: EvalCaseManualInput): Promise<EvalCase> {
    const data = await apiFetch<unknown>(`/agents/${agentId}/eval-cases/${caseId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    return EvalCase.parse(data);
  },

  async deleteEvalCase(agentId: string, caseId: string): Promise<void> {
    await apiFetch<unknown>(`/agents/${agentId}/eval-cases/${caseId}`, { method: 'DELETE' });
  },

  /** No `caseIds` (or an empty call) runs every case for the agent as one batch. */
  async runEvalBatch(agentId: string, caseIds?: string[]): Promise<EvalBatchDetail> {
    const data = await apiFetch<unknown>(`/agents/${agentId}/eval-runs`, {
      method: 'POST',
      body: caseIds !== undefined ? JSON.stringify({ case_ids: caseIds }) : undefined,
    });
    return EvalBatchDetail.parse(data);
  },

  /** Newest-first; server default limit 20, capped at 100. */
  async getEvalRuns(agentId: string, limit?: number): Promise<EvalBatchRecord[]> {
    const qs = limit != null ? `?limit=${limit}` : '';
    const data = await apiFetch<unknown>(`/agents/${agentId}/eval-runs${qs}`);
    return EvalBatchRecord.array().parse(data);
  },

  async getEvalBatch(agentId: string, batchId: string): Promise<EvalBatchDetail> {
    const data = await apiFetch<unknown>(`/agents/${agentId}/eval-runs/${batchId}`);
    return EvalBatchDetail.parse(data);
  },

  /** Server swaps `a`/`b` if needed so `a` is always the older run. */
  async compareEvalRuns(agentId: string, a: string, b: string): Promise<EvalRunComparison> {
    const data = await apiFetch<unknown>(
      `/agents/${agentId}/eval-runs/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
    );
    return EvalRunComparison.parse(data);
  },

  async getEvalDashboardIndex(): Promise<EvalDashboardIndex> {
    const data = await apiFetch<unknown>('/eval-dashboard');
    return EvalDashboardIndex.parse(data);
  },

  async getEvalDashboard(agentId: string): Promise<EvalDashboard> {
    const data = await apiFetch<unknown>(`/eval-dashboard/${agentId}`);
    return EvalDashboard.parse(data);
  },
};

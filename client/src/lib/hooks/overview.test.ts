/* overview.test.ts — useOverviewIntent: query states, SSE progress/done wiring,
   and refresh() 429 surfacing. Mocks `api` at the module boundary (matches this
   repo's existing hook-testing convention — no MSW server is configured here). */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BlastRadius, PrIntentDto, PrIntentResponse } from "@devdigest/shared";
import { useOverviewBlastRadius, useOverviewIntent } from "./overview";
import type { PrBlastRadiusResponse } from "./overview";
import { api, ApiError } from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      post: vi.fn(),
    },
  };
});

/** Minimal fake EventSource — captures registered listeners so tests can
   fire synthetic `info`/`done` events without a real network connection. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  listeners: Record<string, ((ev: MessageEvent) => void)[]> = {};
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(kind: string, cb: EventListener) {
    (this.listeners[kind] ??= []).push(cb as (ev: MessageEvent) => void);
  }
  removeEventListener() {}
  close() {
    this.closed = true;
  }
  emit(kind: string, data?: unknown) {
    for (const cb of this.listeners[kind] ?? []) {
      cb({ data: data !== undefined ? JSON.stringify(data) : "" } as MessageEvent);
    }
  }
}

function renderWithClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  const view = renderHook(() => useOverviewIntent("pr-1"), {
    wrapper: ({ children }) => React.createElement(QueryClientProvider, { client: qc }, children),
  });
  return { ...view, qc, invalidateSpy };
}

const intentDto: PrIntentDto = {
  goal: "Fix session restore",
  inScope: ["auth"],
  outOfScope: ["billing"],
  riskAreas: [],
  references: [],
  model: "anthropic/claude-haiku-4-5-20251001",
  cost: { tokensIn: 100, tokensOut: 50, usd: 0.001 },
  computedAt: "2026-07-04T00:00:00.000Z",
};

describe("useOverviewIntent", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("moves from loading to computing, streams progress via SSE, and invalidates on done", async () => {
    const computing: PrIntentResponse = { status: "computing", runId: "run-1" };
    vi.mocked(api.get).mockResolvedValue(computing as never);

    const { result, invalidateSpy } = renderWithClient();

    expect(result.current.status).toBe("loading");

    await waitFor(() => expect(result.current.status).toBe("computing"));
    expect(result.current.progress).toBeNull();

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected an EventSource to have been opened");
    expect(es.url).toContain("/pulls/pr-1/overview/intent/stream?runId=run-1");

    act(() => es.emit("info", { msg: "Extracting intent" }));
    await waitFor(() => expect(result.current.progress).toBe("Extracting intent"));

    act(() => es.emit("done"));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["overview-intent", "pr-1"] }),
    );
  });

  it("reports ready-stale with staleReasons, and surfaces a 429 from refresh() as an ApiError", async () => {
    const stale: PrIntentResponse = {
      status: "ready-stale",
      data: intentDto,
      staleReasons: ["head_sha"],
    };
    vi.mocked(api.get).mockResolvedValue(stale as never);
    vi.mocked(api.post).mockRejectedValue(new ApiError("Too many requests", 429, "rate_limited"));

    const { result } = renderWithClient();

    await waitFor(() => expect(result.current.status).toBe("ready-stale"));
    expect(result.current.data).toEqual(intentDto);
    expect(result.current.staleReasons).toEqual(["head_sha"]);

    await expect(result.current.refresh()).rejects.toMatchObject({ status: 429 });
  });

  it("on refresh() sets isRefreshing, opens the SSE for the returned runId, and clears on done", async () => {
    // Server-side row is fresh (ready) — the refresh POST is what triggers
    // the recompute, and its runId is what the hook must subscribe to.
    const ready: PrIntentResponse = { status: "ready", data: intentDto };
    vi.mocked(api.get).mockResolvedValue(ready as never);
    vi.mocked(api.post).mockResolvedValue({ runId: "refresh-run" } as never);

    const { result, invalidateSpy } = renderWithClient();

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.isRefreshing).toBe(false);
    // No stream should be open yet — the row is 'ready', no server-side compute.
    expect(FakeEventSource.instances).toHaveLength(0);

    await act(async () => {
      await result.current.refresh();
    });

    // The hook must expose isRefreshing = true immediately after the POST,
    // even though GET /intent would still return the pre-refresh 'ready' row.
    await waitFor(() => expect(result.current.isRefreshing).toBe(true));
    // Data stays visible during the refresh — the user has context while
    // waiting for the recomputed row to land.
    expect(result.current.data).toEqual(intentDto);

    const es = FakeEventSource.instances[0];
    if (!es) throw new Error("expected an EventSource for the refresh runId");
    expect(es.url).toContain("/pulls/pr-1/overview/intent/stream?runId=refresh-run");

    act(() => es.emit("info", { msg: "Extracting intent" }));
    await waitFor(() => expect(result.current.progress).toBe("Extracting intent"));

    act(() => es.emit("done"));
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["overview-intent", "pr-1"] });
  });
});

const blastRadius: BlastRadius = {
  changed_symbols: [{ name: "restoreSession", file: "src/auth/session.ts", kind: "function" }],
  downstream: [
    {
      symbol: "restoreSession",
      callers: [{ name: "handleLogin", file: "src/auth/login.ts", line: 42 }],
      endpoints_affected: ["/api/auth/login"],
      crons_affected: [],
    },
  ],
  summary: "Touches session restore and its single caller in the login flow.",
};

function renderBlastRadiusWithClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderHook(() => useOverviewBlastRadius("pr-1"), {
    wrapper: ({ children }) => React.createElement(QueryClientProvider, { client: qc }, children),
  });
  return { ...view, qc };
}

describe("useOverviewBlastRadius", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches the blast-radius envelope and returns the ready payload", async () => {
    const ready: PrBlastRadiusResponse = { status: "ready", data: blastRadius };
    vi.mocked(api.get).mockResolvedValue(ready as never);

    const { result } = renderBlastRadiusWithClient();

    expect(result.current.isPending).toBe(true);

    await waitFor(() => expect(result.current.data).toEqual(ready));
    expect(api.get).toHaveBeenCalledWith("/pulls/pr-1/overview/blast-radius");
  });
});

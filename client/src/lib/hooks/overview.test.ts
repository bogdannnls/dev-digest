/* overview.test.ts — useOverviewIntent: query states, SSE progress/done wiring,
   and refresh() 429 surfacing. Mocks `api` at the module boundary (matches this
   repo's existing hook-testing convention — no MSW server is configured here). */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PrIntentDto, PrIntentResponse } from "@devdigest/shared";
import { useOverviewIntent } from "./overview";
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
});

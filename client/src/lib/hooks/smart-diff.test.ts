/* smart-diff.test.ts — useSmartDiff: happy path, error path, disabled when
   prId is null. Mocks `api` at the module boundary (matches this repo's
   existing hook-testing convention — no MSW server is configured here). */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SmartDiff } from "@devdigest/shared";
import { useSmartDiff } from "./smart-diff";
import { api } from "../api";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
    },
  };
});

function renderWithClient(prId: string | null | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(() => useSmartDiff(prId), {
    wrapper: ({ children }) => React.createElement(QueryClientProvider, { client: qc }, children),
  });
}

const smartDiffFixture: SmartDiff = {
  groups: [],
  split_suggestion: {
    too_big: false,
    total_lines: 0,
    proposed_splits: [],
  },
};

describe("useSmartDiff", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the fetched SmartDiff on the happy path", async () => {
    vi.mocked(api.get).mockResolvedValue(smartDiffFixture as never);

    const { result } = renderWithClient("pr-1");

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual(smartDiffFixture);
    expect(api.get).toHaveBeenCalledWith("/pulls/pr-1/smart-diff");
  });

  it("exposes isError when api.get rejects", async () => {
    vi.mocked(api.get).mockRejectedValue(new Error("boom"));

    const { result } = renderWithClient("pr-1");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it("does not call api.get and reflects the disabled state when prId is null", () => {
    const { result } = renderWithClient(null);

    expect(api.get).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.fetchStatus).toBe("idle");
  });
});

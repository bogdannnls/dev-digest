import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PrOverviewBriefResponse } from "@devdigest/shared";
import { PrBriefCard } from "./PrBriefCard";

// Mock the hook module so we don't hit the network in the component test.
vi.mock("@/lib/hooks/overview", () => ({
  useOverviewBrief: vi.fn(),
}));
import { useOverviewBrief } from "@/lib/hooks/overview";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe("PrBriefCard", () => {
  it("renders a loading skeleton while the query is pending", () => {
    (useOverviewBrief as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
    });
    render(wrap(<PrBriefCard prId="pr-1" />));
    expect(screen.getByTestId("pr-brief-loading")).toBeInTheDocument();
  });

  it("renders an empty state when there are no runs yet", () => {
    (useOverviewBrief as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: { status: "no_runs" } satisfies PrOverviewBriefResponse,
      isLoading: false,
      isError: false,
      error: null,
    });
    render(wrap(<PrBriefCard prId="pr-1" />));
    expect(screen.getByText(/no review runs yet/i)).toBeInTheDocument();
  });

  it("renders verdict, score, findings/blockers and cost when ready", async () => {
    (useOverviewBrief as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        status: "ready",
        data: {
          verdict: "request_changes",
          summary: "Tighten the auth path",
          findingsCount: 4,
          blockersCount: 2,
          score: 65,
          totalCost: { tokensIn: 1500, tokensOut: 300, usd: 0.018 },
          computedAt: "2026-06-24T12:00:00Z",
          basedOnRunIds: ["run-1", "run-2"],
        },
      } satisfies PrOverviewBriefResponse,
      isLoading: false,
      isError: false,
      error: null,
    });
    render(wrap(<PrBriefCard prId="pr-1" />));
    await waitFor(() => {
      expect(screen.getByText(/request changes/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Tighten the auth path")).toBeInTheDocument();
    expect(screen.getByText("65")).toBeInTheDocument(); // score
    expect(screen.getByText(/4 findings/i)).toBeInTheDocument();
    expect(screen.getByText(/2 blockers/i)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.018/)).toBeInTheDocument();
    expect(screen.getByText(/1,?500.*in/i)).toBeInTheDocument();
  });

  it("renders an error state when the query fails", () => {
    (useOverviewBrief as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("boom"),
    });
    render(wrap(<PrBriefCard prId="pr-1" />));
    expect(screen.getByText(/couldn.t load the brief/i)).toBeInTheDocument();
  });
});

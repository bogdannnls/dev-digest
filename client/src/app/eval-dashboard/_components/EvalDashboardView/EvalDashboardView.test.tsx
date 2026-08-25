import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { EvalDashboardIndex } from "@devdigest/shared";
import messages from "../../../../../messages/en/eval.json";
import { EvalDashboardView } from "./EvalDashboardView";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/hooks", () => ({
  useEvalDashboardIndex: vi.fn(),
}));
import { useEvalDashboardIndex } from "@/lib/hooks";

afterEach(cleanup);

function renderWithIntl(ui: React.ReactElement) {
  return render(<NextIntlClientProvider locale="en" messages={{ eval: messages }}>{ui}</NextIntlClientProvider>);
}

const DATA: EvalDashboardIndex = {
  agents: [
    {
      agent_id: "ag1",
      agent_name: "Security Reviewer",
      model: "gpt-4.1",
      cases_total: 5,
      last_run: {
        id: "batch-1",
        owner_kind: "agent",
        owner_id: "ag1",
        agent_version: 1,
        model: "gpt-4.1",
        provider: "openai",
        ran_at: "2026-08-20T10:00:00Z",
        finished_at: "2026-08-20T10:01:00Z",
        status: "succeeded",
        cases_total: 5,
        traces_passed: 4,
        recall: 0.8,
        precision: 0.6,
        citation_accuracy: 0.9,
        duration_ms: 1200,
        cost_usd: 0.0123,
        tokens_in: 100,
        tokens_out: 50,
        error: null,
      },
      trend: [],
    },
  ],
  recent_runs: [
    {
      id: "batch-1",
      owner_kind: "agent",
      owner_id: "ag1",
      agent_version: 1,
      model: "gpt-4.1",
      provider: "openai",
      ran_at: "2026-08-20T10:00:00Z",
      finished_at: "2026-08-20T10:01:00Z",
      status: "succeeded",
      cases_total: 5,
      traces_passed: 4,
      recall: 0.8,
      precision: 0.6,
      citation_accuracy: 0.9,
      duration_ms: 1200,
      cost_usd: 0.0123,
      tokens_in: 100,
      tokens_out: 50,
      error: null,
      agent_name: "Security Reviewer",
    },
  ],
};

describe("EvalDashboardView", () => {
  it("renders the agents list and the cross-agent recent-runs feed", () => {
    vi.mocked(useEvalDashboardIndex).mockReturnValue({
      data: DATA,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    renderWithIntl(<EvalDashboardView />);

    // Agents summary table and the cross-agent recent-runs feed both name the
    // same agent (one row each) and repeat its metrics.
    expect(screen.getByText("Agents")).toBeInTheDocument();
    expect(screen.getByText("Recent runs")).toBeInTheDocument();
    expect(screen.getAllByText("Security Reviewer")).toHaveLength(2);
    expect(screen.getAllByText("80%")).toHaveLength(2);
    expect(screen.getAllByText("60%")).toHaveLength(2);
    expect(screen.getAllByText("90%")).toHaveLength(2);
  });

  it("shows the empty state when there are no agents and no runs", () => {
    vi.mocked(useEvalDashboardIndex).mockReturnValue({
      data: { agents: [], recent_runs: [] },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    renderWithIntl(<EvalDashboardView />);

    expect(screen.getAllByText("No runs yet. Create an eval case and run it.").length).toBeGreaterThanOrEqual(1);
  });
});

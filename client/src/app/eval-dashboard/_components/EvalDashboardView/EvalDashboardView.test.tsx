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

  it("draws no sparkline for an agent with a single run, instead of NaN coordinates", () => {
    // Regression guard. `Sparkline` spaces points as `i / (data.length - 1)`,
    // so one point divides zero by zero and React warns "Received NaN for the
    // `cx` attribute". The component is vendored, so the guard lives in
    // MetricCell — this asserts the guard, not the component.
    const onePoint = {
      ...DATA,
      agents: [
        {
          ...DATA.agents[0]!,
          trend: [
            { ran_at: "2026-08-20T10:00:00Z", recall: 0.8, precision: 0.6, citation_accuracy: 0.9, pass_rate: 0.8, cost_usd: null },
          ],
        },
      ],
    };
    vi.mocked(useEvalDashboardIndex).mockReturnValue({
      data: onePoint, isLoading: false, isError: false, error: null, refetch: vi.fn(),
    } as any);

    const { container } = renderWithIntl(<EvalDashboardView />);

    // No svg at all in the metric cells, and nothing carrying a NaN coordinate.
    expect(container.querySelectorAll("circle")).toHaveLength(0);
    expect(container.innerHTML).not.toContain("NaN");
    // The percentages still render — the guard hides the chart, not the data.
    expect(screen.getAllByText("80%").length).toBeGreaterThanOrEqual(1);
  });

  it("still draws a sparkline once there are two runs to connect", () => {
    const twoPoints = {
      ...DATA,
      agents: [
        {
          ...DATA.agents[0]!,
          trend: [
            { ran_at: "2026-08-20T10:00:00Z", recall: 0.5, precision: 0.4, citation_accuracy: 1, pass_rate: 0.5, cost_usd: null },
            { ran_at: "2026-08-21T10:00:00Z", recall: 0.8, precision: 0.6, citation_accuracy: 0.9, pass_rate: 0.8, cost_usd: null },
          ],
        },
      ],
    };
    vi.mocked(useEvalDashboardIndex).mockReturnValue({
      data: twoPoints, isLoading: false, isError: false, error: null, refetch: vi.fn(),
    } as any);

    const { container } = renderWithIntl(<EvalDashboardView />);

    expect(container.querySelectorAll("circle").length).toBeGreaterThan(0);
    expect(container.innerHTML).not.toContain("NaN");
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

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PrIntentDto } from "@devdigest/shared";
import { ApiError } from "@/lib/api";
import { IntentCard } from "./IntentCard";

vi.mock("@/lib/hooks/overview", () => ({
  useOverviewIntent: vi.fn(),
}));
import { useOverviewIntent } from "@/lib/hooks/overview";

const toastError = vi.fn();
vi.mock("@/lib/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: toastError, info: vi.fn(), toast: vi.fn() }),
}));

const mockedUseOverviewIntent = useOverviewIntent as unknown as ReturnType<typeof vi.fn>;

const baseIntent: PrIntentDto = {
  goal: "Add rate limiting to the public API.",
  inScope: ["add middleware", "cover REST routes"],
  outOfScope: ["DB schema change"],
  riskAreas: [
    { icon: "shield", label: "auth middleware" },
    { icon: "zap", label: "n+1 risk" },
  ],
  references: [{ kind: "github_issue", id: "42", status: "ok", bodyChars: 400 }],
  model: "claude-haiku-4.5",
  cost: { tokensIn: 1200, tokensOut: 250, usd: 0.0009 },
  computedAt: new Date().toISOString(),
};

describe("IntentCard", () => {
  beforeEach(() => {
    toastError.mockClear();
  });

  it("renders a loading skeleton with no header actions (no Refresh button)", () => {
    mockedUseOverviewIntent.mockReturnValue({
      status: "loading",
      data: null,
      staleReasons: null,
      error: null,
      progress: null,
      isRefreshing: false,
      refresh: vi.fn(),
    });
    render(<IntentCard prId="pr-1" />);
    expect(screen.getByTestId("intent-loading")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
  });

  it("renders a computing skeleton with progress line and disabled Refresh", () => {
    mockedUseOverviewIntent.mockReturnValue({
      status: "computing",
      data: null,
      staleReasons: null,
      error: null,
      progress: "Collecting references…",
      isRefreshing: false,
      refresh: vi.fn(),
    });
    render(<IntentCard prId="pr-1" />);
    expect(screen.getByTestId("intent-computing")).toBeInTheDocument();
    expect(screen.getByText("Collecting references…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
  });

  it("renders the full card when ready, including reference chips", () => {
    mockedUseOverviewIntent.mockReturnValue({
      status: "ready",
      data: baseIntent,
      staleReasons: null,
      error: null,
      progress: null,
      isRefreshing: false,
      refresh: vi.fn(),
    });
    render(<IntentCard prId="pr-1" />);
    expect(screen.getByText(baseIntent.goal)).toBeInTheDocument();
    expect(screen.getByText("add middleware")).toBeInTheDocument();
    expect(screen.getByText("DB schema change")).toBeInTheDocument();
    expect(screen.getByText("auth middleware")).toBeInTheDocument();
    expect(screen.getByText("github #42")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeEnabled();
  });

  it("hides the reference row entirely when references is empty", () => {
    mockedUseOverviewIntent.mockReturnValue({
      status: "ready",
      data: { ...baseIntent, references: [] },
      staleReasons: null,
      error: null,
      progress: null,
      isRefreshing: false,
      refresh: vi.fn(),
    });
    render(<IntentCard prId="pr-1" />);
    expect(screen.queryByText(/sources:/i)).not.toBeInTheDocument();
  });

  it("renders the amber stale banner with a human-readable reason", () => {
    mockedUseOverviewIntent.mockReturnValue({
      status: "ready-stale",
      data: baseIntent,
      staleReasons: ["head_sha"],
      error: null,
      progress: null,
      isRefreshing: false,
      refresh: vi.fn(),
    });
    render(<IntentCard prId="pr-1" />);
    expect(screen.getByRole("status")).toHaveTextContent(/stale.*the pr was updated/i);
    expect(screen.getByRole("button", { name: /refresh/i })).toBeEnabled();
  });

  it("renders an error state with red text and an enabled Refresh button", () => {
    mockedUseOverviewIntent.mockReturnValue({
      status: "error",
      data: null,
      staleReasons: null,
      error: "Extraction failed",
      progress: null,
      isRefreshing: false,
      refresh: vi.fn(),
    });
    render(<IntentCard prId="pr-1" />);
    expect(screen.getByText("Extraction failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeEnabled();
  });

  it("calls refresh() on Refresh click in the ready state, and shows a toast on 429", async () => {
    const user = userEvent.setup();
    const refresh = vi.fn().mockRejectedValue(new ApiError("Too many requests", 429, "rate_limited", {
      retryAfterSeconds: 42,
    }));
    mockedUseOverviewIntent.mockReturnValue({
      status: "ready",
      data: baseIntent,
      staleReasons: null,
      error: null,
      progress: null,
      isRefreshing: false,
      refresh,
    });
    render(<IntentCard prId="pr-1" />);
    await user.click(screen.getByRole("button", { name: /refresh/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/try again in 42s/i));
  });

  it("renders an in-progress banner (and disables Refresh) while a user-initiated refresh is streaming", () => {
    mockedUseOverviewIntent.mockReturnValue({
      status: "ready",
      data: baseIntent,
      staleReasons: null,
      error: null,
      progress: "Extracting intent…",
      isRefreshing: true,
      refresh: vi.fn(),
    });
    render(<IntentCard prId="pr-1" />);
    // Prior data stays visible so the user has context while the recompute streams.
    expect(screen.getByText(baseIntent.goal)).toBeInTheDocument();
    // The banner announces the recompute and picks up SSE progress messages.
    const banner = screen.getByTestId("intent-refreshing");
    expect(banner).toHaveTextContent(/extracting intent/i);
    // Refresh button is disabled to prevent double-firing the rate limit.
    expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
  });
});

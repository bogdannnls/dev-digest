import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { FindingRecord, PrWhyRiskBrief, ReviewRecord } from "@devdigest/shared";
import { ApiError } from "@/lib/api";
import messages from "../../../../../../../../../../messages/en/whyRiskBrief.json";
import { WhyRiskBriefCard } from "./WhyRiskBriefCard";

// vi.mock factories are hoisted above imports — closed-over fns must be lifted
// with vi.hoisted, otherwise they're `undefined` when the factory runs
// (client/INSIGHTS.md 2026-06-19).
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/hooks/overview", () => ({
  useOverviewBriefSynth: vi.fn(),
}));
import { useOverviewBriefSynth } from "@/lib/hooks/overview";

vi.mock("@/lib/hooks/reviews", () => ({
  usePrReviews: vi.fn(),
}));
import { usePrReviews } from "@/lib/hooks/reviews";

const toastError = vi.fn();
vi.mock("@/lib/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: toastError, info: vi.fn(), toast: vi.fn() }),
}));

const mockedUseOverviewBriefSynth = useOverviewBriefSynth as unknown as ReturnType<typeof vi.fn>;
const mockedUsePrReviews = usePrReviews as unknown as ReturnType<typeof vi.fn>;

afterEach(cleanup);

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ whyRiskBrief: messages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const finding = (over: Partial<FindingRecord>): FindingRecord =>
  ({
    id: "f1",
    severity: "CRITICAL",
    category: "security",
    title: "Rate limit bypass",
    file: "src/auth/limiter.ts",
    start_line: 42,
    end_line: 50,
    rationale: "...",
    suggestion: null,
    confidence: 0.9,
    kind: null,
    trifecta_components: null,
    evidence: null,
    review_id: "r1",
    accepted_at: null,
    dismissed_at: null,
    ...over,
  }) as FindingRecord;

const review = (findings: FindingRecord[]): ReviewRecord =>
  ({
    id: "r1",
    pr_id: "pr-1",
    agent_id: "a1",
    run_id: "run-1",
    agent_name: "Security Reviewer",
    kind: "review",
    verdict: "request_changes",
    summary: "s",
    score: 60,
    model: "claude-haiku-4.5",
    grounding: null,
    created_at: new Date().toISOString(),
    findings,
  }) as ReviewRecord;

const baseBrief: PrWhyRiskBrief = {
  what: "Adds rate limiting to the public API.",
  why: "Prevents abuse of unauthenticated endpoints.",
  riskLevel: "high",
  risks: [{ icon: "shield", label: "auth middleware" }],
  reviewFocus: [
    { findingId: "f1", note: "Bypass allows unlimited requests." },
    { findingId: "f2", note: "Missing input validation." },
  ],
  model: "claude-haiku-4.5",
  cost: { tokensIn: 1000, tokensOut: 200, usd: 0.0008 },
  computedAt: new Date().toISOString(),
  basedOn: { headSha: "abc123", reviewId: "r1", intentComputedAt: new Date().toISOString() },
};

function mockOverview(overrides: Partial<ReturnType<typeof useOverviewBriefSynth>>) {
  mockedUseOverviewBriefSynth.mockReturnValue({
    status: "loading",
    data: null,
    missing: null,
    staleReasons: null,
    error: null,
    progress: null,
    isRefreshing: false,
    refresh: vi.fn(),
    ...overrides,
  });
}

describe("WhyRiskBriefCard", () => {
  beforeEach(() => {
    toastError.mockClear();
    push.mockClear();
    mockedUsePrReviews.mockReturnValue({
      data: [review([finding({ id: "f1" }), finding({ id: "f2", title: "Missing input check" })])],
    });
  });

  it("renders a computing skeleton with progress and a disabled Refresh (AC-40)", () => {
    mockOverview({ status: "computing", progress: "Synthesizing…" });
    renderWithIntl(<WhyRiskBriefCard prId="pr-1" baseHref="/repos/r1/pulls/1" />);
    expect(screen.getByTestId("why-risk-brief-computing")).toBeInTheDocument();
    expect(screen.getByText("Synthesizing…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
  });

  it("renders the full ready card: what/why/riskLevel/risks + review focus list (AC-40)", () => {
    mockOverview({ status: "ready", data: baseBrief });
    renderWithIntl(<WhyRiskBriefCard prId="pr-1" baseHref="/repos/r1/pulls/1" />);
    expect(screen.getByText(baseBrief.what)).toBeInTheDocument();
    expect(screen.getByText(baseBrief.why)).toBeInTheDocument();
    expect(screen.getByText(/high risk/i)).toBeInTheDocument();
    expect(screen.getByText("auth middleware")).toBeInTheDocument();
    expect(screen.getByText(/review focus/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeEnabled();
  });

  it("renders the amber ready-stale banner naming the reason (AC-40)", () => {
    mockOverview({
      status: "ready-stale",
      data: baseBrief,
      staleReasons: ["new_review"],
    });
    renderWithIntl(<WhyRiskBriefCard prId="pr-1" baseHref="/repos/r1/pulls/1" />);
    expect(screen.getByRole("status")).toHaveTextContent(/stale.*new review completed/i);
  });

  it("renders a red error state with an enabled Refresh (AC-40)", () => {
    mockOverview({ status: "error", error: "Synthesis failed" });
    renderWithIntl(<WhyRiskBriefCard prId="pr-1" baseHref="/repos/r1/pulls/1" />);
    expect(screen.getByTestId("why-risk-brief-error")).toBeInTheDocument();
    expect(screen.getByText("Synthesis failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeEnabled();
  });

  it("not_ready names a single missing input and hides the Refresh control (AC-40, AC-41, AC-42)", () => {
    mockOverview({ status: "not_ready", missing: ["review"] });
    renderWithIntl(<WhyRiskBriefCard prId="pr-1" baseHref="/repos/r1/pulls/1" />);
    expect(screen.getByTestId("why-risk-brief-not-ready")).toBeInTheDocument();
    expect(screen.getByText(/review/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /refresh/i })).not.toBeInTheDocument();
  });

  it("not_ready names both missing inputs when intent and review are both missing (AC-41)", () => {
    mockOverview({ status: "not_ready", missing: ["intent", "review"] });
    renderWithIntl(<WhyRiskBriefCard prId="pr-1" baseHref="/repos/r1/pulls/1" />);
    const body = screen.getByTestId("why-risk-brief-not-ready");
    expect(body).toHaveTextContent(/intent/i);
    expect(body).toHaveTextContent(/review/i);
  });

  it("renders Review focus as an ordered/keyboard-reachable list and navigates to a finding's file:line on click (AC-43, AC-44)", async () => {
    const user = userEvent.setup();
    mockOverview({ status: "ready", data: baseBrief });
    renderWithIntl(<WhyRiskBriefCard prId="pr-1" baseHref="/repos/r1/pulls/1" />);

    const list = screen.getByRole("list");
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    const [firstLink] = links;
    expect(firstLink).toBeDefined();
    // rank + file:line + note are shown
    expect(list).toHaveTextContent("1");
    expect(list).toHaveTextContent("src/auth/limiter.ts:42");
    expect(list).toHaveTextContent("Bypass allows unlimited requests.");

    // Links are real anchors — naturally reachable via Tab.
    await user.tab();
    await user.tab();
    expect(firstLink).toHaveFocus();

    await user.click(firstLink!);
    expect(push).toHaveBeenCalledWith(
      expect.stringContaining("/repos/r1/pulls/1?tab=findings#finding-f1"),
    );
  });

  it("shows a 'try again shortly' message (not a generic error) when refresh hits a 429 (AC-45)", async () => {
    const user = userEvent.setup();
    const refresh = vi
      .fn()
      .mockRejectedValue(new ApiError("Too many requests", 429, "rate_limited", { retryAfterSeconds: 30 }));
    mockOverview({ status: "ready", data: baseBrief, refresh });
    renderWithIntl(<WhyRiskBriefCard prId="pr-1" baseHref="/repos/r1/pulls/1" />);

    await user.click(screen.getByRole("button", { name: /refresh/i }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/try again in 30s/i));
  });
});

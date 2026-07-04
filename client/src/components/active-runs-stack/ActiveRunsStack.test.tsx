import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import type { ActiveRunGlobal } from "../../lib/hooks/reviews";

// Query hook is mocked at module scope so each test can control the returned
// list. We only care about render output, not React Query itself.
const mockData: { data: ActiveRunGlobal[] } = { data: [] };
vi.mock("../../lib/hooks/reviews", () => ({
  useActiveRuns: () => ({ data: mockData.data }),
}));

// next/link renders an anchor in a fragment we can query.
vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) =>
    React.createElement("a", { href, ...rest }, children),
}));

import { ActiveRunsStack } from "./ActiveRunsStack";

afterEach(() => {
  mockData.data = [];
  cleanup();
});

function makeRun(overrides: Partial<ActiveRunGlobal> = {}): ActiveRunGlobal {
  // Spread AFTER defaults so explicit `null` in overrides survives (?? would
  // fold null → default and silently mask the "null agent_name" case).
  return {
    run_id: "r1",
    agent_id: "a1",
    agent_name: "Security Reviewer",
    ran_at: new Date(Date.now() - 5_000).toISOString(),
    pr_id: "p1",
    pr_number: 482,
    repo_id: "repo-uuid-1",
    repo_owner: "acme",
    repo_name: "web",
    ...overrides,
  };
}

describe("ActiveRunsStack", () => {
  it("renders nothing when there are no active runs", () => {
    mockData.data = [];
    const { container } = render(<ActiveRunsStack />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one card per active run with a link to the PR page", () => {
    mockData.data = [
      makeRun({ run_id: "r1", agent_name: "Security Reviewer", pr_number: 482, repo_id: "repo-a" }),
      makeRun({ run_id: "r2", agent_name: "Performance Reviewer", pr_number: 501, repo_id: "repo-b" }),
    ];
    render(<ActiveRunsStack />);

    expect(screen.getByText("Security Reviewer")).toBeTruthy();
    expect(screen.getByText("Performance Reviewer")).toBeTruthy();

    // getAllByRole returns DOM order, not visual order — column-reverse only
    // flips the visual axis, insertion order is preserved in the DOM.
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/repos/repo-a/pulls/482",
      "/repos/repo-b/pulls/501",
    ]);
  });

  it("shows elapsed time and PR number in the subline", () => {
    mockData.data = [
      makeRun({ ran_at: new Date(Date.now() - 12_000).toISOString(), pr_number: 482 }),
    ];
    render(<ActiveRunsStack />);
    // 12s (±1s tolerance because Date.now moved a hair between assignment and render)
    const sub = screen.getByText(/PR #482 · \d+s/);
    expect(sub).toBeTruthy();
  });

  it("falls back to 'Agent' when agent_name is null", () => {
    mockData.data = [makeRun({ agent_name: null })];
    render(<ActiveRunsStack />);
    expect(screen.getByText("Agent")).toBeTruthy();
  });

  it("exposes the region as a live status area for screen readers", () => {
    mockData.data = [makeRun()];
    render(<ActiveRunsStack />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-label")).toBe("Runs in progress");
  });

  it("formats elapsed above 60s as `Xm Ys`", async () => {
    vi.useFakeTimers();
    const startedAt = new Date(Date.now() - 75_000).toISOString();
    mockData.data = [makeRun({ ran_at: startedAt })];
    try {
      render(<ActiveRunsStack />);
      // Advance the 1s tick interval once so state updates and re-renders.
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByText(/PR #482 · 1m/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

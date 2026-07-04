/**
 * RunHistory — the badge must reflect the review OUTCOME, not the run lifecycle.
 * Regression guard for the "green ✓ done on a run that found 5 blockers" bug:
 * a settled run is colored/labelled by its denormalized blocker/finding counts,
 * and shows the review score ring.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { RunSummary, PrCommit } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/prReview.json";
import { RunHistory } from "./RunHistory";

afterEach(cleanup);

function run(o: Partial<RunSummary>): RunSummary {
  return {
    run_id: "run-1",
    agent_id: "a1",
    agent_name: "Security Reviewer",
    provider: "openrouter",
    model: "deepseek/deepseek-v4-flash",
    status: "done",
    error: null,
    duration_ms: 1000,
    tokens_in: 100,
    tokens_out: 50,
    findings_count: 0,
    grounding: "0/0 passed",
    ran_at: "2026-06-11T18:44:34.000Z",
    score: null,
    blockers: null,
    ...o,
  };
}

function commit(o: Partial<PrCommit> & { sha: string }): PrCommit {
  return {
    message: `msg for ${o.sha}`,
    author: "Alice",
    committed_at: "2026-06-11T18:00:00.000Z",
    ...o,
  };
}

function renderRuns(runs: RunSummary[], commits: PrCommit[] = []) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      <RunHistory runs={runs} commits={commits} onOpenTrace={() => {}} />
    </NextIntlClientProvider>,
  );
}

describe("RunHistory — outcome badge", () => {
  it("a done run WITH blockers reads 'rejected' (never green 'done') + shows the score ring", () => {
    renderRuns([run({ status: "done", findings_count: 5, blockers: 5, score: 0 })]);
    expect(screen.getByText("rejected")).toBeInTheDocument();
    expect(screen.queryByText("done")).not.toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument(); // CircularScore renders the number
    expect(screen.getByText(/5 blockers/)).toBeInTheDocument();
  });

  it("a clean done run reads 'approved'", () => {
    renderRuns([run({ status: "done", findings_count: 0, blockers: 0, score: 95 })]);
    expect(screen.getByText("approved")).toBeInTheDocument();
    expect(screen.getByText("95")).toBeInTheDocument();
  });

  it("a done run with non-blocking findings reads 'reviewed'", () => {
    renderRuns([run({ status: "done", findings_count: 3, blockers: 0, score: 72 })]);
    expect(screen.getByText("reviewed")).toBeInTheDocument();
    expect(screen.queryByText(/blockers/)).not.toBeInTheDocument();
  });

  it("a failed run reads 'error'", () => {
    renderRuns([run({ status: "failed", error: "boom", score: null, blockers: null })]);
    expect(screen.getByText("error")).toBeInTheDocument();
  });

  it("a running run reads 'running'", () => {
    renderRuns([run({ status: "running", score: null, blockers: null })]);
    expect(screen.getByText("running")).toBeInTheDocument();
  });
});

describe("RunHistory — commits are collapsed into one section", () => {
  it("renders a single group header (default collapsed) — individual commit shas are hidden", () => {
    renderRuns(
      [],
      [
        commit({ sha: "aaaaaaa1111111", message: "first fix", committed_at: "2026-06-11T10:00:00.000Z" }),
        commit({ sha: "bbbbbbb2222222", message: "second fix", committed_at: "2026-06-11T11:00:00.000Z" }),
        commit({ sha: "ccccccc3333333", message: "third fix", committed_at: "2026-06-11T12:00:00.000Z" }),
      ],
    );

    // Header shows the count and the LATEST commit's short sha + message (12:00 > 11:00 > 10:00).
    expect(screen.getByText(/3 commits/)).toBeInTheDocument();
    expect(screen.getByText("ccccccc")).toBeInTheDocument();
    expect(screen.getByText("third fix")).toBeInTheDocument();

    // Older commits are NOT visible while collapsed.
    expect(screen.queryByText("aaaaaaa")).not.toBeInTheDocument();
    expect(screen.queryByText("bbbbbbb")).not.toBeInTheDocument();
    expect(screen.queryByText("first fix")).not.toBeInTheDocument();
    expect(screen.queryByText("second fix")).not.toBeInTheDocument();
  });

  it("expands to reveal every commit when the header is clicked", () => {
    renderRuns(
      [],
      [
        commit({ sha: "aaaaaaa1111111", message: "first fix", committed_at: "2026-06-11T10:00:00.000Z" }),
        commit({ sha: "bbbbbbb2222222", message: "second fix", committed_at: "2026-06-11T11:00:00.000Z" }),
      ],
    );

    fireEvent.click(screen.getByRole("button", { name: /toggle commits list/i }));

    // Older commit is only visible once expanded.
    expect(screen.getByText("aaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("first fix")).toBeInTheDocument();
    // Latest commit appears twice: once in the header, once in the expanded list.
    expect(screen.getAllByText("bbbbbbb")).toHaveLength(2);
    expect(screen.getAllByText("second fix")).toHaveLength(2);
  });

  it("uses ICU 'one' plural for a single commit", () => {
    renderRuns([], [commit({ sha: "aaaaaaa1111111", message: "solo" })]);
    expect(screen.getByText(/^1 commit$/)).toBeInTheDocument();
  });

  it("renders nothing when both runs and commits are empty", () => {
    const { container } = renderRuns([], []);
    expect(container).toBeEmptyDOMElement();
  });
});

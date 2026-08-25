import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { EvalBatchRecord, EvalRunComparison as EvalRunComparisonData } from "@devdigest/shared";
import messages from "../../../../messages/en/eval.json";
import { EM_DASH } from "../format";
import { EvalRunComparison } from "./EvalRunComparison";

afterEach(cleanup);

function renderWithIntl(ui: React.ReactElement) {
  return render(<NextIntlClientProvider locale="en" messages={{ eval: messages }}>{ui}</NextIntlClientProvider>);
}

function makeBatch(overrides: Partial<EvalBatchRecord> = {}): EvalBatchRecord {
  return {
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
    ...overrides,
  };
}

const COMPARISON: EvalRunComparisonData = {
  a: makeBatch({ id: "batch-1" }),
  b: makeBatch({ id: "batch-2" }),
  system_prompt_a: "You are the OLD reviewer prompt.",
  system_prompt_b: "You are the NEW reviewer prompt.",
  delta: { recall: 0.1, precision: null, citation_accuracy: -0.05, cost_usd: 0.0005 },
};

describe("EvalRunComparison", () => {
  it("renders both system prompts and the metric deltas, including a null delta as an em dash", () => {
    renderWithIntl(<EvalRunComparison comparison={COMPARISON} onClose={vi.fn()} />);

    expect(screen.getByText("You are the OLD reviewer prompt.")).toBeInTheDocument();
    expect(screen.getByText("You are the NEW reviewer prompt.")).toBeInTheDocument();

    expect(screen.getByText("+10%")).toBeInTheDocument();
    expect(screen.getByText("-5%")).toBeInTheDocument();
    expect(screen.getByText("+$0.0005")).toBeInTheDocument();
    // precision's delta is null (no comparison possible) — rendered as an em dash, never 0%.
    expect(screen.getByText(EM_DASH)).toBeInTheDocument();
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.queryByText("+0%")).not.toBeInTheDocument();
  });

  it("calls onClose when the close action is used", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithIntl(<EvalRunComparison comparison={COMPARISON} onClose={onClose} />);
    // The modal header's X button and the footer button are both named "Close";
    // both wire to the same onClose prop.
    const [closeButton] = screen.getAllByRole("button", { name: "Close" });
    await user.click(closeButton!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

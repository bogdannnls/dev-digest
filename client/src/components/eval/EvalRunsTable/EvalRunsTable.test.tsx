import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { EvalBatchRecord } from "@devdigest/shared";
import messages from "../../../../messages/en/eval.json";
import { EM_DASH } from "../format";
import { EvalRunsTable } from "./EvalRunsTable";

afterEach(cleanup);

function renderWithIntl(ui: React.ReactElement) {
  return render(<NextIntlClientProvider locale="en" messages={{ eval: messages }}>{ui}</NextIntlClientProvider>);
}

function makeRun(overrides: Partial<EvalBatchRecord> = {}): EvalBatchRecord {
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

describe("EvalRunsTable", () => {
  it("renders a row per run, formatting a run with a vacuous denominator as an em dash rather than 0%", () => {
    const runs = [
      makeRun({ id: "batch-1" }),
      makeRun({ id: "batch-2", recall: null, precision: null, citation_accuracy: null }),
    ];
    renderWithIntl(<EvalRunsTable runs={runs} />);

    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    // batch-2's three vacuous metrics render as an em dash, never 0%.
    expect(screen.getAllByText(EM_DASH)).toHaveLength(3);
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
  });

  it("caps selection at two rows and only enables the compare action, with the selected ids, once exactly two are checked", async () => {
    const user = userEvent.setup();
    const onCompare = vi.fn();
    const runs = [makeRun({ id: "a" }), makeRun({ id: "b" }), makeRun({ id: "c" })];
    renderWithIntl(<EvalRunsTable runs={runs} onCompare={onCompare} />);

    const compareButton = screen.getByRole("button", { name: "Compare selected" });
    expect(compareButton).toBeDisabled();

    const checkboxes = screen.getAllByRole("checkbox", { name: "Select run to compare" });
    await user.click(checkboxes[0]!);
    expect(compareButton).toBeDisabled();

    await user.click(checkboxes[1]!);
    expect(compareButton).toBeEnabled();

    // A third selection is rejected — selection stays capped at two.
    await user.click(checkboxes[2]!);
    expect(checkboxes[2]).not.toBeChecked();
    expect(compareButton).toBeEnabled();

    await user.click(compareButton);
    expect(onCompare).toHaveBeenCalledWith("a", "b");
  });
});

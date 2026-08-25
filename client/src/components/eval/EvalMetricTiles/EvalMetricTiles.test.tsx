import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../../messages/en/eval.json";
import { EM_DASH } from "../format";
import { EvalMetricTiles } from "./EvalMetricTiles";

afterEach(cleanup);

function renderWithIntl(ui: React.ReactElement) {
  return render(<NextIntlClientProvider locale="en" messages={{ eval: messages }}>{ui}</NextIntlClientProvider>);
}

describe("EvalMetricTiles", () => {
  it("renders a null recall, precision and citation accuracy as an em dash, never 0%", () => {
    renderWithIntl(
      <EvalMetricTiles recall={null} precision={null} citationAccuracy={null} tracesPassed={0} tracesTotal={5} />,
    );
    // Three metric tiles are vacuous (contract 3.4): recall, precision, citation accuracy.
    expect(screen.getAllByText(EM_DASH)).toHaveLength(3);
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    // tracesPassed is a plain count, not a vacuous-denominator metric, so it still renders.
    expect(screen.getByText("0/5")).toBeInTheDocument();
  });

  it("renders a normal set of values as percentages, and traces passed as its count", () => {
    renderWithIntl(
      <EvalMetricTiles recall={0.8} precision={0.65} citationAccuracy={0.92} tracesPassed={4} tracesTotal={5} />,
    );
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("65%")).toBeInTheDocument();
    expect(screen.getByText("92%")).toBeInTheDocument();
    expect(screen.getByText("4/5")).toBeInTheDocument();
  });
});

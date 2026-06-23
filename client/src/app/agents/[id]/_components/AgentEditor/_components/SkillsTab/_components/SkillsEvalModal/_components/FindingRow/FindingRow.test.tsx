import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../../../../../messages/en/agents.json";
import { FindingRow } from "./FindingRow";
import type { AnnotatedFinding } from "../EvalResultsSplit/diffFindings";

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
      {ui}
    </NextIntlClientProvider>
  );
}

const f = (annotation: "new" | "missing" | "shared"): AnnotatedFinding => ({
  id: "fx-1",
  severity: "WARNING",
  category: "test",
  title: "Missing branch",
  file: "src/x.ts",
  start_line: 12,
  end_line: 12,
  rationale: "",
  confidence: 0.9,
  annotation,
});

describe("FindingRow", () => {
  it("renders file:line and title", () => {
    render(wrap(<FindingRow finding={f("shared")} />));
    expect(screen.getByText("src/x.ts:12")).toBeInTheDocument();
    expect(screen.getByText(/Missing branch/)).toBeInTheDocument();
  });

  it("shows NEW badge when annotation is new", () => {
    render(wrap(<FindingRow finding={f("new")} />));
    expect(screen.getByText("NEW")).toBeInTheDocument();
  });

  it("shows MISSING badge when annotation is missing", () => {
    render(wrap(<FindingRow finding={f("missing")} />));
    expect(screen.getByText("MISSING")).toBeInTheDocument();
  });

  it("shows no badge when annotation is shared", () => {
    render(wrap(<FindingRow finding={f("shared")} />));
    expect(screen.queryByText("NEW")).toBeNull();
    expect(screen.queryByText("MISSING")).toBeNull();
  });
});

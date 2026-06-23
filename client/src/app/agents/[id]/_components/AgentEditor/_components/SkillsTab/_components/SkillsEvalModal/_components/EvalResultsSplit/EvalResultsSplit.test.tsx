import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../../../../../messages/en/agents.json";
import { EvalResultsSplit } from "./EvalResultsSplit";
import type { Finding } from "@devdigest/shared";

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
      {ui}
    </NextIntlClientProvider>
  );
}

const findingFixture = (
  file: string,
  start_line: number,
  title: string,
): Finding => ({
  id: `${file}:${start_line}`,
  severity: "WARNING",
  category: "test",
  title,
  file,
  start_line,
  end_line: start_line,
  rationale: "",
  confidence: 0.9,
});

const mkSide = (
  findings: Finding[],
  tokensIn = 100,
  tokensOut = 200,
  costUsd: number | null = 0.0012,
) => ({
  findings,
  grounding: "1/1 passed",
  tokensIn,
  tokensOut,
  costUsd,
});

const sharedFinding = findingFixture("a.ts", 1, "shared one");
const uniqueWithFinding = findingFixture("b.ts", 2, "unique to with");

const result = {
  fixture: { id: "fx1", title: "Fixture 1" },
  with_skills: mkSide([sharedFinding, uniqueWithFinding]),
  without_skills: mkSide([sharedFinding]),
};

describe("EvalResultsSplit", () => {
  it("renders both columns with correct counts", () => {
    render(wrap(<EvalResultsSplit result={result as any} />));
    const withCol = screen.getByTestId("with-column");
    const withoutCol = screen.getByTestId("without-column");
    // heading h3 text is "With skills (2)" / "Without skills (1)"
    expect(within(withCol).getByRole("heading", { name: /With skills \(2\)/ })).toBeInTheDocument();
    expect(within(withoutCol).getByRole("heading", { name: /Without skills \(1\)/ })).toBeInTheDocument();
  });

  it("renders NEW badge on with-column for a unique finding", () => {
    render(wrap(<EvalResultsSplit result={result as any} />));
    const withCol = screen.getByTestId("with-column");
    expect(within(withCol).getByText("NEW")).toBeInTheDocument();
  });

  it("renders empty state when a column has no findings", () => {
    const empty = {
      ...result,
      with_skills: mkSide([]),
    };
    render(wrap(<EvalResultsSplit result={empty as any} />));
    expect(screen.getByText("No findings")).toBeInTheDocument();
  });

  it("renders tokens and cost per column", () => {
    render(wrap(<EvalResultsSplit result={result as any} />));
    // tokensIn(100) + tokensOut(200) = 300 tokens per column
    expect(screen.getAllByText(/300 tokens/i).length).toBe(2);
    expect(screen.getAllByText(/\$0\.0012/i).length).toBe(2);
  });
});

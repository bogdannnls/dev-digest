import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { Agent, EvalCase } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/eval.json";
import { EvalsTab } from "./EvalsTab";

vi.mock("@/lib/hooks/eval", () => ({
  useEvalCases: vi.fn(),
  useEvalRuns: vi.fn(),
  useEvalBatch: vi.fn(),
  useRunEvalBatch: vi.fn(),
  useDeleteEvalCase: vi.fn(),
}));
import {
  useEvalCases,
  useEvalRuns,
  useEvalBatch,
  useRunEvalBatch,
  useDeleteEvalCase,
} from "@/lib/hooks/eval";

afterEach(cleanup);

function renderWithIntl(ui: React.ReactElement) {
  return render(<NextIntlClientProvider locale="en" messages={{ eval: messages }}>{ui}</NextIntlClientProvider>);
}

const AGENT: Agent = {
  id: "ag1",
  name: "Security Reviewer",
  description: "Flags secrets and injection",
  provider: "openai",
  model: "gpt-4.1",
  system_prompt: "You are a security reviewer.",
  output_schema: null,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  enabled: true,
  version: 1,
};

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "case-1",
    owner_kind: "agent",
    owner_id: "ag1",
    name: "stripe-key-leak",
    input_diff: "--- a/src/config.ts\n+++ b/src/config.ts\n@@ -1,1 +1,1 @@\n+const x = 1;",
    input_files: null,
    input_meta: { origin: "manual", source_finding_id: null, source_pr_id: null, source_review_id: null },
    expected_output: {
      kind: "must_find",
      file: "src/config.ts",
      start_line: 10,
      end_line: 10,
      severity: null,
      category: null,
      title: null,
    },
    notes: null,
    ...overrides,
  };
}

const mockRunBatch = vi.fn();
const mockDeleteCase = vi.fn();

beforeEach(() => {
  vi.mocked(useEvalCases).mockReturnValue({ data: [], isLoading: false, isError: false, refetch: vi.fn() } as any);
  vi.mocked(useEvalRuns).mockReturnValue({ data: [] } as any);
  vi.mocked(useEvalBatch).mockReturnValue({ data: undefined } as any);
  vi.mocked(useRunEvalBatch).mockReturnValue({ mutate: mockRunBatch, isPending: false } as any);
  vi.mocked(useDeleteEvalCase).mockReturnValue({ mutate: mockDeleteCase, isPending: false } as any);
  mockRunBatch.mockClear();
  mockDeleteCase.mockClear();
});

describe("EvalsTab", () => {
  it("shows the empty state when the agent has no eval cases", () => {
    renderWithIntl(<EvalsTab agent={AGENT} />);
    expect(
      screen.getByText("No eval cases yet. Create one to assert this agent's expected findings on a sample diff."),
    ).toBeInTheDocument();
  });

  it("lists cases from a populated set with the right expectation-kind label", () => {
    vi.mocked(useEvalCases).mockReturnValue({
      data: [
        makeCase({ id: "case-1", name: "stripe-key-leak" }),
        makeCase({
          id: "case-2",
          name: "safe-env-read",
          expected_output: {
            kind: "must_not_flag",
            file: "src/env.ts",
            start_line: 3,
            end_line: 3,
            severity: null,
            category: null,
            title: null,
          },
        }),
      ],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as any);

    renderWithIntl(<EvalsTab agent={AGENT} />);

    expect(screen.getByText("stripe-key-leak")).toBeInTheDocument();
    expect(screen.getByText("safe-env-read")).toBeInTheDocument();
    expect(screen.getByText("Must find")).toBeInTheDocument();
    expect(screen.getByText("Must not flag")).toBeInTheDocument();
  });

  it("fires the run mutation for a single case when its run action is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(useEvalCases).mockReturnValue({
      data: [makeCase({ id: "case-1", name: "stripe-key-leak" })],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as any);

    renderWithIntl(<EvalsTab agent={AGENT} />);

    await user.click(screen.getByRole("button", { name: "Run" }));
    expect(mockRunBatch).toHaveBeenCalledWith(["case-1"], expect.anything());
  });
});

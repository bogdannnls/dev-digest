import type React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { FindingRecord, PrFile, SmartDiff } from "@devdigest/shared";
import shellMessages from "../../../../../../../../messages/en/shell.json";
import { DiffTab } from "./DiffTab";

// next/navigation mock — DiffTab now soft-navigates on badge click.
const { replaceMock } = vi.hoisted(() => ({ replaceMock: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  useParams: () => ({ repoId: "r1", number: "42" }),
}));

// Module mocks — per client/INSIGHTS.md, `vi.mock` factories that return
// `vi.fn()` directly (no closed-over const) don't need `vi.hoisted`. We only
// need `vi.hoisted` when the factory closes over an outer variable, which
// isn't the case here (each test calls `mockReturnValue` on the imported fn).
vi.mock("@/lib/hooks/smart-diff", () => ({
  useSmartDiff: vi.fn(),
}));
vi.mock("@/lib/hooks/reviews", () => ({
  usePrComments: vi.fn(),
  useCreatePrComment: vi.fn(),
}));

import { useSmartDiff } from "@/lib/hooks/smart-diff";
import { usePrComments, useCreatePrComment } from "@/lib/hooks/reviews";

afterEach(() => {
  cleanup();
  replaceMock.mockReset();
});

const files: PrFile[] = [
  { path: "src/core.ts", additions: 10, deletions: 2, patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
  { path: "src/wiring.ts", additions: 3, deletions: 0, patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
  { path: "src/boilerplate.ts", additions: 1, deletions: 1, patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
];

function mockComments() {
  (usePrComments as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ data: [] });
  (useCreatePrComment as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    isPending: false,
    mutateAsync: vi.fn(),
  });
}

function smartDiffFixture(overrides?: Partial<SmartDiff>): SmartDiff {
  return {
    groups: [
      { role: "core", files: [{ path: "src/core.ts", additions: 10, deletions: 2, finding_lines: [10, 20] }] },
      { role: "wiring", files: [{ path: "src/wiring.ts", additions: 3, deletions: 0, finding_lines: [] }] },
      {
        role: "boilerplate",
        files: [{ path: "src/boilerplate.ts", additions: 1, deletions: 1, finding_lines: [] }],
      },
    ],
    split_suggestion: { too_big: false, total_lines: 16, proposed_splits: [] },
    ...overrides,
  };
}

function finding(overrides: Partial<FindingRecord>): FindingRecord {
  return {
    id: "f-default",
    review_id: "r-1",
    severity: "WARNING",
    category: "correctness",
    title: "Sample finding",
    file: "src/core.ts",
    start_line: 10,
    end_line: 10,
    rationale: "why",
    suggestion: null,
    confidence: 0.9,
    kind: null,
    trifecta_components: null,
    evidence: null,
    accepted_at: null,
    dismissed_at: null,
    ...overrides,
  } as FindingRecord;
}

function renderDiffTab(props: Partial<React.ComponentProps<typeof DiffTab>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ shell: shellMessages }}>
      <DiffTab prId="pr-1" filesCount={3} files={files} allFindings={[]} {...props} />
    </NextIntlClientProvider>,
  );
}

describe("DiffTab", () => {
  it("falls back to the flat DiffViewer while the smart diff is loading", () => {
    mockComments();
    (useSmartDiff as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });

    renderDiffTab();

    expect(screen.getByText("src/core.ts")).toBeInTheDocument();
    expect(screen.getByText("src/wiring.ts")).toBeInTheDocument();
    expect(screen.getByText("src/boilerplate.ts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /core/i })).not.toBeInTheDocument();
  });

  it("falls back to the flat DiffViewer when the smart diff query errors", () => {
    mockComments();
    (useSmartDiff as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });

    renderDiffTab();

    expect(screen.getByText("src/core.ts")).toBeInTheDocument();
    expect(screen.getByText("src/wiring.ts")).toBeInTheDocument();
    expect(screen.getByText("src/boilerplate.ts")).toBeInTheDocument();
  });

  it("renders three group headers with correct file/finding counts, keeping boilerplate collapsed until clicked", async () => {
    const user = userEvent.setup();
    mockComments();
    (useSmartDiff as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: smartDiffFixture(),
      isLoading: false,
      isError: false,
    });

    // Header finding count is now driven by allFindings (source of truth for
    // per-finding badges), not the smart-diff finding_lines hint.
    const allFindings = [
      finding({ id: "f-1", file: "src/core.ts", start_line: 10 }),
      finding({ id: "f-2", file: "src/core.ts", start_line: 20 }),
    ];

    renderDiffTab({ allFindings });

    // Scope to elements exposing aria-expanded — the group headers, not the
    // per-finding badges (which are plain buttons with no aria-expanded).
    const coreHeader = screen.getByRole("button", { name: /core/i, expanded: true });
    const wiringHeader = screen.getByRole("button", { name: /wiring/i, expanded: true });
    const boilerplateHeader = screen.getByRole("button", { name: /boilerplate/i, expanded: false });
    expect(coreHeader).toHaveTextContent("1 file");
    expect(coreHeader).toHaveTextContent("2 findings");
    expect(wiringHeader).toHaveTextContent("1 file");
    expect(boilerplateHeader).toHaveTextContent("1 file");

    // Core + wiring are expanded by default; boilerplate is not.
    expect(screen.getByText("src/core.ts")).toBeInTheDocument();
    expect(screen.getByText("src/wiring.ts")).toBeInTheDocument();
    expect(screen.queryByText("src/boilerplate.ts")).not.toBeInTheDocument();
    expect(boilerplateHeader).toHaveAttribute("aria-expanded", "false");

    await user.click(boilerplateHeader);
    expect(screen.getByText("src/boilerplate.ts")).toBeInTheDocument();
    expect(boilerplateHeader).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the too_big banner only when split_suggestion.too_big is true", () => {
    mockComments();
    (useSmartDiff as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: smartDiffFixture({ split_suggestion: { too_big: true, total_lines: 2000, proposed_splits: [] } }),
      isLoading: false,
      isError: false,
    });

    const { rerender } = renderDiffTab();
    expect(screen.getByText(/2000/)).toBeInTheDocument();
    expect(screen.getByText(/consider splitting/i)).toBeInTheDocument();

    (useSmartDiff as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: smartDiffFixture({ split_suggestion: { too_big: false, total_lines: 2000, proposed_splits: [] } }),
      isLoading: false,
      isError: false,
    });
    rerender(
      <NextIntlClientProvider locale="en" messages={{ shell: shellMessages }}>
        <DiffTab prId="pr-1" filesCount={3} files={files} allFindings={[]} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(/consider splitting/i)).not.toBeInTheDocument();
  });

  it("renders one badge per finding labeled basename:line, and clicking it soft-navigates to the findings tab with the finding id", async () => {
    const user = userEvent.setup();
    mockComments();
    (useSmartDiff as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: smartDiffFixture({
        groups: [
          { role: "core", files: [{ path: "src/core.ts", additions: 10, deletions: 2, finding_lines: [10, 20] }] },
          { role: "wiring", files: [{ path: "src/wiring.ts", additions: 3, deletions: 0, finding_lines: [] }] },
          {
            role: "boilerplate",
            files: [{ path: "src/boilerplate.ts", additions: 1, deletions: 1, finding_lines: [5] }],
          },
        ],
      }),
      isLoading: false,
      isError: false,
    });

    const allFindings = [
      finding({ id: "f-core-10", file: "src/core.ts", start_line: 10, severity: "CRITICAL" }),
      finding({ id: "f-core-20", file: "src/core.ts", start_line: 20, severity: "WARNING" }),
      finding({ id: "f-boil-5", file: "src/boilerplate.ts", start_line: 5, severity: "SUGGESTION" }),
    ];

    renderDiffTab({ allFindings });

    // core.ts has two findings — expect two per-line badges. wiring.ts has none.
    expect(screen.getByText("core.ts:10")).toBeInTheDocument();
    expect(screen.getByText("core.ts:20")).toBeInTheDocument();
    expect(screen.queryByText(/^wiring\.ts:/)).not.toBeInTheDocument();

    // boilerplate group starts collapsed → its badges aren't in the DOM yet.
    expect(screen.queryByText("boilerplate.ts:5")).not.toBeInTheDocument();
    const boilerplateHeader = screen.getByRole("button", { name: /boilerplate/i, expanded: false });
    await user.click(boilerplateHeader);
    expect(screen.getByText("boilerplate.ts:5")).toBeInTheDocument();

    // Clicking a badge should soft-navigate to Findings tab with the finding id.
    await user.click(screen.getByText("core.ts:10"));
    expect(replaceMock).toHaveBeenCalledTimes(1);
    const url = replaceMock.mock.calls[0]![0] as string;
    expect(url).toContain("/repos/r1/pulls/42");
    expect(url).toContain("tab=findings");
    expect(url).toContain("findingId=f-core-10");
  });
});

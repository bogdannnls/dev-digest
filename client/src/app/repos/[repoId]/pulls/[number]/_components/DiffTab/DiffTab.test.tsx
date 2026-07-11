import type React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { FindingRecord, PrFile, SmartDiff } from "@devdigest/shared";
import shellMessages from "../../../../../../../../messages/en/shell.json";
import prReviewMessages from "../../../../../../../../messages/en/prReview.json";
import { DiffTab } from "./DiffTab";

// The action mutation is called by the drawer's Accept/Dismiss buttons — we
// don't exercise those here, but the drawer imports the hook at module load.
vi.mock("@/lib/hooks/smart-diff", () => ({
  useSmartDiff: vi.fn(),
}));
vi.mock("@/lib/hooks/reviews", () => ({
  usePrComments: vi.fn(),
  useCreatePrComment: vi.fn(),
  useFindingAction: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { useSmartDiff } from "@/lib/hooks/smart-diff";
import { usePrComments, useCreatePrComment } from "@/lib/hooks/reviews";

afterEach(cleanup);

const files: PrFile[] = [
  {
    path: "src/core.ts",
    additions: 10,
    deletions: 2,
    // Small synthetic patch so parsePatch yields lines whose newNo values match
    // the finding start_line values (10, 20) used below.
    patch:
      "@@ -1,3 +10,3 @@\n a\n-b\n+c\n@@ -5,1 +20,1 @@\n-x\n+y",
  },
  { path: "src/wiring.ts", additions: 3, deletions: 0, patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
  { path: "src/boilerplate.ts", additions: 1, deletions: 1, patch: "@@ -1,1 +5,1 @@\n-a\n+b" },
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
    <NextIntlClientProvider
      locale="en"
      messages={{ shell: shellMessages, prReview: prReviewMessages }}
    >
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

    // Header finding count is driven by allFindings (source of truth) — passing
    // two findings for src/core.ts to satisfy the "2 findings" assertion.
    const allFindings = [
      finding({ id: "f-1", file: "src/core.ts", start_line: 10 }),
      finding({ id: "f-2", file: "src/core.ts", start_line: 20 }),
    ];

    renderDiffTab({ allFindings });

    const coreHeader = screen.getByRole("button", { name: /core/i, expanded: true });
    const wiringHeader = screen.getByRole("button", { name: /wiring/i, expanded: true });
    const boilerplateHeader = screen.getByRole("button", { name: /boilerplate/i, expanded: false });
    expect(coreHeader).toHaveTextContent("1 file");
    expect(coreHeader).toHaveTextContent("2 findings");
    expect(wiringHeader).toHaveTextContent("1 file");
    expect(boilerplateHeader).toHaveTextContent("1 file");

    expect(screen.getByText("src/core.ts")).toBeInTheDocument();
    expect(screen.getByText("src/wiring.ts")).toBeInTheDocument();
    expect(screen.queryByText("src/boilerplate.ts")).not.toBeInTheDocument();

    await user.click(boilerplateHeader);
    expect(screen.getByText("src/boilerplate.ts")).toBeInTheDocument();
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
      <NextIntlClientProvider
        locale="en"
        messages={{ shell: shellMessages, prReview: prReviewMessages }}
      >
        <DiffTab prId="pr-1" filesCount={3} files={files} allFindings={[]} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(/consider splitting/i)).not.toBeInTheDocument();
  });

  it("clicking a header chip scrolls to the target line inside the diff", async () => {
    const user = userEvent.setup();
    mockComments();
    (useSmartDiff as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: smartDiffFixture(),
      isLoading: false,
      isError: false,
    });

    const allFindings = [
      finding({ id: "f-core-10", file: "src/core.ts", start_line: 10, severity: "CRITICAL" }),
    ];

    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    renderDiffTab({ allFindings });

    await user.click(screen.getByText("core.ts:10"));
    // scrollIntoView is deferred one animation frame after the click.
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled(), { timeout: 500 });
  });

  it("clicking an inline severity badge opens the FindingDetailDrawer with the finding's title", async () => {
    const user = userEvent.setup();
    mockComments();
    (useSmartDiff as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      data: smartDiffFixture(),
      isLoading: false,
      isError: false,
    });

    const allFindings = [
      finding({
        id: "f-core-10",
        file: "src/core.ts",
        start_line: 10,
        title: "Off-by-one in bounds check",
        rationale: "the loop misses the last element",
        severity: "CRITICAL",
      }),
    ];

    renderDiffTab({ allFindings });

    // Inline badge lives on the line whose newNo === 10 — the CodeLine renders
    // a button with aria-label "Open finding: <title>".
    const inlineBtn = screen.getByRole("button", { name: /open finding: off-by-one/i });
    await user.click(inlineBtn);

    // Drawer content appears — title visible in the drawer header.
    await waitFor(() =>
      expect(screen.getAllByText(/off-by-one in bounds check/i).length).toBeGreaterThan(0),
    );
    // Drawer body renders the finding's rationale via <Markdown>.
    expect(screen.getByText(/loop misses the last element/i)).toBeInTheDocument();
  });
});

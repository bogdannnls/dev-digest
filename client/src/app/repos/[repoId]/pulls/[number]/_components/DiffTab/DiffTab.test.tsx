import type React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { PrFile, SmartDiff } from "@devdigest/shared";
import shellMessages from "../../../../../../../../messages/en/shell.json";
import { DiffTab } from "./DiffTab";

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

afterEach(cleanup);

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

    renderDiffTab();

    // Scope to elements exposing aria-expanded — the group headers, not the
    // per-file finding badges (which are plain buttons with no aria-expanded).
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

  it("renders a finding-count badge only for files with finding_lines, and clicking it scrolls to and expands the group", async () => {
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

    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    renderDiffTab();

    // src/core.ts has findings -> badge present with count text.
    expect(screen.getByText(/core\.ts · 2 findings/i)).toBeInTheDocument();
    // src/wiring.ts has none -> no badge text for it.
    expect(screen.queryByText(/wiring\.ts · \d+ finding/i)).not.toBeInTheDocument();

    // boilerplate group is collapsed by default, so its badge isn't rendered
    // until expanded — click the header first, then the badge appears.
    const boilerplateHeader = screen.getByRole("button", { name: /boilerplate/i, expanded: false });
    await user.click(boilerplateHeader);
    expect(screen.getByRole("button", { name: /boilerplate/i, expanded: true })).toBeInTheDocument();

    const badge = screen.getByText(/boilerplate\.ts · 1 finding/i);
    await user.click(badge);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });
});

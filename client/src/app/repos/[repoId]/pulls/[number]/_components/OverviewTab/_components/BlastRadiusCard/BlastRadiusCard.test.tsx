import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BlastRadius } from "@devdigest/shared";
import { githubBlobUrl } from "@/lib/github-urls";
import { BlastRadiusCard } from "./BlastRadiusCard";

vi.mock("@/lib/hooks/overview", () => ({
  useOverviewBlastRadius: vi.fn(),
}));
import { useOverviewBlastRadius } from "@/lib/hooks/overview";

vi.mock("@/lib/hooks/repo-intel", () => ({
  useResyncRepoIntel: vi.fn(),
  useRepoIntelStatus: vi.fn(),
}));
import { useResyncRepoIntel, useRepoIntelStatus } from "@/lib/hooks/repo-intel";

const mockedUseOverviewBlastRadius = useOverviewBlastRadius as unknown as ReturnType<typeof vi.fn>;
const mockedUseResyncRepoIntel = useResyncRepoIntel as unknown as ReturnType<typeof vi.fn>;
const mockedUseRepoIntelStatus = useRepoIntelStatus as unknown as ReturnType<typeof vi.fn>;

const resyncMutate = vi.fn();

const BLAST_WITH_ROWS: BlastRadius = {
  changed_symbols: [{ name: "chargeCard", file: "src/billing/charge.ts", kind: "function" }],
  downstream: [
    {
      symbol: "chargeCard",
      callers: [{ name: "handleCheckout", file: "src/checkout/handler.ts", line: 42 }],
      endpoints_affected: ["POST /checkout"],
      crons_affected: ["nightly-reconcile"],
    },
  ],
  summary: "1 changed symbol affects 1 endpoint.",
};

const BLAST_EMPTY: BlastRadius = {
  changed_symbols: [],
  downstream: [],
  summary: "No changed symbols detected.",
};

function renderBlastRadiusCard(overrides: Partial<React.ComponentProps<typeof BlastRadiusCard>> = {}) {
  return render(
    <BlastRadiusCard
      prId="pr-1"
      repoId="repo-1"
      repoFullName="acme/widgets"
      headSha="abc123"
      {...overrides}
    />,
  );
}

describe("BlastRadiusCard", () => {
  beforeEach(() => {
    resyncMutate.mockClear();
    mockedUseResyncRepoIntel.mockReturnValue({ mutate: resyncMutate, isPending: false });
    mockedUseRepoIntelStatus.mockReturnValue({ data: undefined, isLoading: false });
  });

  it("renders a skeleton while loading", () => {
    mockedUseOverviewBlastRadius.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    renderBlastRadiusCard();
    expect(screen.getByTestId("blast-radius-loading")).toBeInTheDocument();
  });

  it("renders an error state when the query fails", () => {
    mockedUseOverviewBlastRadius.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderBlastRadiusCard();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/couldn't load the blast radius/i)).toBeInTheDocument();
  });

  it("degraded + no rows: shows the 'index not built' empty state and resync CTA fires the mutation", async () => {
    const user = userEvent.setup();
    mockedUseOverviewBlastRadius.mockReturnValue({
      data: { status: "degraded", reason: "no index", data: BLAST_EMPTY },
      isLoading: false,
      isError: false,
    });
    renderBlastRadiusCard();

    expect(screen.getByText("Repo index isn't built yet")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /resync repo index/i }));
    expect(resyncMutate).toHaveBeenCalledTimes(1);
  });

  it("ready + no rows: shows a DISTINCT positive empty state from the degraded-empty one", () => {
    mockedUseOverviewBlastRadius.mockReturnValue({
      data: { status: "ready", data: BLAST_EMPTY },
      isLoading: false,
      isError: false,
    });
    renderBlastRadiusCard();

    expect(screen.getByText("Indexed — no downstream impact detected")).toBeInTheDocument();
    expect(screen.queryByText("Repo index isn't built yet")).not.toBeInTheDocument();
  });

  it("ready + rows: renders the counts row, an expandable symbol node with caller link, and endpoint + cron chips", async () => {
    const user = userEvent.setup();
    mockedUseOverviewBlastRadius.mockReturnValue({
      data: { status: "ready", data: BLAST_WITH_ROWS },
      isLoading: false,
      isError: false,
    });
    renderBlastRadiusCard();

    // Counts row: 1 symbol, 1 caller, 1 endpoint, 1 cron.
    expect(screen.getByTestId("blast-counts")).toHaveTextContent(
      "1 symbol · 1 caller · 1 endpoint · 1 cron",
    );

    // Symbol node is expanded by default (it has >=1 caller) — caller link visible immediately.
    const callerLink = screen.getByRole("link", { name: /src\/checkout\/handler\.ts:42/i });
    expect(callerLink).toHaveAttribute(
      "href",
      githubBlobUrl("acme/widgets", "abc123", "src/checkout/handler.ts", 42),
    );
    expect(screen.getByText("POST /checkout")).toBeInTheDocument();
    expect(screen.getByText("nightly-reconcile")).toBeInTheDocument();

    // Collapse the node — the caller row disappears.
    const nodeHeader = screen.getByRole("button", { name: /chargeCard/i });
    await user.click(nodeHeader);
    expect(
      screen.queryByRole("link", { name: /src\/checkout\/handler\.ts:42/i }),
    ).not.toBeInTheDocument();

    // Expand it again — the caller row (and chips) reappear.
    await user.click(nodeHeader);
    expect(screen.getByRole("link", { name: /src\/checkout\/handler\.ts:42/i })).toBeInTheDocument();
    expect(screen.getByText("POST /checkout")).toBeInTheDocument();
  });

  it("ready + rows with no repoFullName/headSha: renders caller as plain mono text, not a broken link", () => {
    mockedUseOverviewBlastRadius.mockReturnValue({
      data: { status: "ready", data: BLAST_WITH_ROWS },
      isLoading: false,
      isError: false,
    });
    renderBlastRadiusCard({ repoFullName: null, headSha: null });

    expect(screen.queryByRole("link", { name: /src\/checkout\/handler\.ts:42/i })).not.toBeInTheDocument();
    expect(screen.getByText("src/checkout/handler.ts:42")).toBeInTheDocument();
  });

  it("degraded + rows: maps the reason ENUM to human copy AND still renders caller rows (degraded must not hide rows)", () => {
    // The server always sends a machine enum (e.g. "index_partial"), never a sentence —
    // the badge must map it to human copy, not render the raw enum.
    mockedUseOverviewBlastRadius.mockReturnValue({
      data: { status: "degraded", reason: "index_partial", data: BLAST_WITH_ROWS },
      isLoading: false,
      isError: false,
    });
    renderBlastRadiusCard();

    expect(
      screen.getByText("Repo index is partial — some callers or endpoints may be missing."),
    ).toBeInTheDocument();
    expect(screen.queryByText("index_partial")).not.toBeInTheDocument();
    expect(screen.getByText("chargeCard")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /src\/checkout\/handler\.ts:42/i })).toBeInTheDocument();
  });

  it("degraded + no rows: refetches the blast query once the index identity advances after resync", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mockedUseOverviewBlastRadius.mockReturnValue({
      data: { status: "degraded", reason: "no_data", data: BLAST_EMPTY },
      isLoading: false,
      isError: false,
      refetch,
    });
    // The status poll starts at one index identity, then advances (rebuild landed).
    let identity: { lastIndexedSha: string; updatedAt: string } = { lastIndexedSha: "sha0", updatedAt: "t0" };
    mockedUseRepoIntelStatus.mockImplementation(() => ({ data: identity }));

    const { rerender } = renderBlastRadiusCard();
    await user.click(screen.getByRole("button", { name: /resync repo index/i }));
    expect(resyncMutate).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled(); // identity unchanged → no premature refetch

    // Simulate the poll observing the rebuilt index.
    identity = { lastIndexedSha: "sha1", updatedAt: "t1" };
    rerender(<BlastRadiusCard prId="pr-1" repoId="repo-1" repoFullName="acme/widgets" headSha="abc123" />);

    expect(refetch).toHaveBeenCalled();
  });
});

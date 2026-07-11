import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BlastRadius } from "@devdigest/shared";
import { githubBlobUrl } from "@/lib/github-urls";
import { repoBlobUrl } from "@/lib/repo-source-urls";
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

// C2 fixture: sort by endpoints desc, then callers desc, then name asc.
// "highEndpoint" (2 endpoints) must lead; "midCallers" (0 endpoints, 3 callers)
// is second; "alpha"/"zebra" tie on counts (0/0) and break alphabetically,
// even though "zebra" appears first in the raw (unsorted) array.
const BLAST_SORT_FIXTURE: BlastRadius = {
  changed_symbols: [
    { name: "zebra", file: "src/z.ts", kind: "function" },
    { name: "highEndpoint", file: "src/b.ts", kind: "function" },
    { name: "alpha", file: "src/a.ts", kind: "function" },
    { name: "midCallers", file: "src/c.ts", kind: "function" },
  ],
  downstream: [
    { symbol: "zebra", callers: [], endpoints_affected: [], crons_affected: [] },
    {
      symbol: "highEndpoint",
      callers: [],
      endpoints_affected: ["EP1", "EP2"],
      crons_affected: [],
    },
    { symbol: "alpha", callers: [], endpoints_affected: [], crons_affected: [] },
    {
      symbol: "midCallers",
      callers: [
        { name: "c1", file: "src/c1.ts", line: 1 },
        { name: "c2", file: "src/c2.ts", line: 2 },
        { name: "c3", file: "src/c3.ts", line: 3 },
      ],
      endpoints_affected: [],
      crons_affected: [],
    },
  ],
  summary: "",
};

// C2 regression fixture: two changed symbols share a name ("process") but come
// from different files with different downstream data. Index-pairing must keep
// them distinct; a `.find((d) => d.symbol === symbol.name)` lookup would show
// the FIRST match's callers ("callerA") under both nodes.
const BLAST_DUP_NAME_FIXTURE: BlastRadius = {
  changed_symbols: [
    { name: "process", file: "src/a.ts", kind: "function" },
    { name: "process", file: "src/b.ts", kind: "function" },
  ],
  downstream: [
    {
      symbol: "process",
      callers: [{ name: "callerA", file: "src/callerA.ts", line: 1 }],
      endpoints_affected: [],
      crons_affected: [],
    },
    {
      symbol: "process",
      callers: [{ name: "callerB", file: "src/callerB.ts", line: 2 }],
      endpoints_affected: [],
      crons_affected: [],
    },
  ],
  summary: "",
};

// C3 fixture: a mix of prod callers (incl. two NEGATIVE cases that must NOT be
// treated as test files — `contest.ts`, `src/testing.ts`) and test callers
// (`.test.ts` suffix + `__tests__/` directory + `.spec.tsx` suffix).
const BLAST_TEST_CALLERS_FIXTURE: BlastRadius = {
  changed_symbols: [{ name: "chargeCard", file: "src/billing/charge.ts", kind: "function" }],
  downstream: [
    {
      symbol: "chargeCard",
      callers: [
        { name: "handleCheckout", file: "src/checkout/handler.ts", line: 10 },
        { name: "contestHandler", file: "src/contest.ts", line: 5 },
        { name: "testingUtilCaller", file: "src/testing.ts", line: 7 },
        { name: "chargeCardTest", file: "src/billing/charge.test.ts", line: 20 },
        { name: "chargeCardSpec", file: "src/billing/__tests__/charge.spec.tsx", line: 3 },
      ],
      endpoints_affected: [],
      crons_affected: [],
    },
  ],
  summary: "",
};

function renderBlastRadiusCard(overrides: Partial<React.ComponentProps<typeof BlastRadiusCard>> = {}) {
  return render(
    <BlastRadiusCard
      prId="pr-1"
      repoId="repo-1"
      repoFullName="acme/widgets"
      headSha="abc123"
      provider="github"
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

  it("(C1) provider-aware caller links: bitbucket uses /src/<sha>/...#lines-N, github uses /blob/<sha>/...#LN, and no provider means no link", () => {
    mockedUseOverviewBlastRadius.mockReturnValue({
      data: { status: "ready", data: BLAST_WITH_ROWS },
      isLoading: false,
      isError: false,
    });

    const { rerender } = renderBlastRadiusCard({ provider: "bitbucket" });
    expect(screen.getByRole("link", { name: /src\/checkout\/handler\.ts:42/i })).toHaveAttribute(
      "href",
      repoBlobUrl("bitbucket", "acme/widgets", "abc123", "src/checkout/handler.ts", 42),
    );
    expect(screen.getByRole("link", { name: /src\/checkout\/handler\.ts:42/i })).toHaveAttribute(
      "href",
      "https://bitbucket.org/acme/widgets/src/abc123/src/checkout/handler.ts#lines-42",
    );

    rerender(
      <BlastRadiusCard
        prId="pr-1"
        repoId="repo-1"
        repoFullName="acme/widgets"
        headSha="abc123"
        provider="github"
      />,
    );
    expect(screen.getByRole("link", { name: /src\/checkout\/handler\.ts:42/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/widgets/blob/abc123/src/checkout/handler.ts#L42",
    );

    rerender(
      <BlastRadiusCard
        prId="pr-1"
        repoId="repo-1"
        repoFullName="acme/widgets"
        headSha="abc123"
        provider={null}
      />,
    );
    expect(screen.queryByRole("link", { name: /src\/checkout\/handler\.ts:42/i })).not.toBeInTheDocument();
    expect(screen.getByText("src/checkout/handler.ts:42")).toBeInTheDocument();
  });

  it("(C2) sorts symbol nodes by endpoints affected desc, then callers desc, then name asc", () => {
    mockedUseOverviewBlastRadius.mockReturnValue({
      data: { status: "ready", data: BLAST_SORT_FIXTURE },
      isLoading: false,
      isError: false,
    });
    renderBlastRadiusCard();

    const names = screen.getAllByTestId("blast-symbol-name").map((el) => el.textContent);
    expect(names).toEqual(["highEndpoint", "midCallers", "alpha", "zebra"]);
  });

  it("(C2) keeps duplicate-named symbols as two distinct nodes with their own downstream data (index-paired, not name-matched)", () => {
    mockedUseOverviewBlastRadius.mockReturnValue({
      data: { status: "ready", data: BLAST_DUP_NAME_FIXTURE },
      isLoading: false,
      isError: false,
    });
    renderBlastRadiusCard();

    expect(screen.getAllByTestId("blast-symbol-name")).toHaveLength(2);
    // Both distinct callers must be visible — a `.find()`-by-name bug would show
    // "callerA" (the first match) under both "process" nodes and never render "callerB".
    expect(screen.getByText("callerA")).toBeInTheDocument();
    expect(screen.getByText("callerB")).toBeInTheDocument();
  });

  it("(C3) collapses test-file callers behind an expandable sub-row; negative heuristic cases stay in the prod list", async () => {
    const user = userEvent.setup();
    mockedUseOverviewBlastRadius.mockReturnValue({
      data: { status: "ready", data: BLAST_TEST_CALLERS_FIXTURE },
      isLoading: false,
      isError: false,
    });
    renderBlastRadiusCard();

    // Prod callers render immediately, INCLUDING the two negative cases that must
    // NOT be classified as test files despite containing "test"/"contest" substrings.
    expect(screen.getByText("handleCheckout")).toBeInTheDocument();
    expect(screen.getByText("contestHandler")).toBeInTheDocument();
    expect(screen.getByText("testingUtilCaller")).toBeInTheDocument();

    // Test callers are collapsed by default — not in the DOM yet.
    expect(screen.queryByText("chargeCardTest")).not.toBeInTheDocument();
    expect(screen.queryByText("chargeCardSpec")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /2 test callers/i });

    // Expanding reveals all test callers.
    await user.click(toggle);
    expect(screen.getByText("chargeCardTest")).toBeInTheDocument();
    expect(screen.getByText("chargeCardSpec")).toBeInTheDocument();
  });

  it("(C4) renders the summary paragraph when non-empty, and renders nothing for an empty summary", () => {
    mockedUseOverviewBlastRadius.mockReturnValue({
      data: { status: "ready", data: BLAST_WITH_ROWS },
      isLoading: false,
      isError: false,
    });
    const { rerender } = renderBlastRadiusCard();
    expect(screen.getByText("1 changed symbol affects 1 endpoint.")).toBeInTheDocument();

    mockedUseOverviewBlastRadius.mockReturnValue({
      data: { status: "ready", data: { ...BLAST_WITH_ROWS, summary: "" } },
      isLoading: false,
      isError: false,
    });
    rerender(
      <BlastRadiusCard
        prId="pr-1"
        repoId="repo-1"
        repoFullName="acme/widgets"
        headSha="abc123"
        provider="github"
      />,
    );
    expect(screen.queryByText("1 changed symbol affects 1 endpoint.")).not.toBeInTheDocument();
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
    rerender(
      <BlastRadiusCard
        prId="pr-1"
        repoId="repo-1"
        repoFullName="acme/widgets"
        headSha="abc123"
        provider="github"
      />,
    );

    expect(refetch).toHaveBeenCalled();
  });
});

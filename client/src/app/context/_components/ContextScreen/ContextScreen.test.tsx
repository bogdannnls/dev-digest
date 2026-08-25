import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import contextMessages from "../../../../../messages/en/context.json";
import { ContextScreen } from "./ContextScreen";
import type { SpecFile } from "@devdigest/shared";

const REPO_ID = "repo-1111-1111-1111-111111111111";

// ContextScreen reads the workspace's currently-active repo via useActiveRepo
// (mirrors ContextTab.test.tsx) — mocked as a boundary.
vi.mock("@/lib/repo-context", () => ({
  useActiveRepo: () => ({
    repoId: REPO_ID,
    setRepoId: vi.fn(),
    repos: [],
    activeRepo: null,
    reposLoaded: true,
  }),
}));

vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Only `api.get` is overridden — `ApiError` stays the real class so the
// component's `error instanceof ApiError && error.code === "repo_not_cloned"`
// check (AC-4) is exercised for real, not re-implemented in the test.
const apiGetMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: apiGetMock } };
});
import { ApiError } from "@/lib/api";

const discovered: SpecFile[] = [
  { path: "specs/2026-07-11-feature-spec.md", size: 200, updated_at: null },
  { path: "docs/architecture.md", size: 80, updated_at: null },
];

function buildClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
}

function wrap(node: React.ReactNode, qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ context: contextMessages }}>
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
});

describe("ContextScreen", () => {
  it("renders a row per discovered document, narrows them by filter, and opens the preview on click (AC-38)", async () => {
    const qc = buildClient();
    qc.setQueryData(["context", REPO_ID], discovered);
    qc.setQueryData(["context-file", REPO_ID, "specs/2026-07-11-feature-spec.md"], {
      path: "specs/2026-07-11-feature-spec.md",
      content: "## Heading\n\nspec body",
      size: 200,
      updated_at: null,
    });

    render(wrap(<ContextScreen />, qc));

    expect(screen.getByText("specs/2026-07-11-feature-spec.md")).toBeInTheDocument();
    expect(screen.getByText("docs/architecture.md")).toBeInTheDocument();

    // Filter narrows the visible list (AC-38).
    await userEvent.type(screen.getByPlaceholderText(/filter documents/i), "architecture");
    expect(screen.queryByText("specs/2026-07-11-feature-spec.md")).not.toBeInTheDocument();
    expect(screen.getByText("docs/architecture.md")).toBeInTheDocument();
    await userEvent.clear(screen.getByPlaceholderText(/filter documents/i));

    // Clicking a row opens the shared preview drawer (AC-38/AC-39).
    await userEvent.click(screen.getByText("specs/2026-07-11-feature-spec.md"));
    expect(screen.getByRole("dialog", { name: "specs/2026-07-11-feature-spec.md" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Heading" })).toBeInTheDocument();
  });

  it("shows a distinct 'repo not cloned' empty state, never the zero-docs state (AC-4)", async () => {
    apiGetMock.mockRejectedValue(new ApiError("Repo not cloned", 409, "repo_not_cloned"));
    const qc = buildClient();

    render(wrap(<ContextScreen />, qc));

    expect(await screen.findByText(/repo not cloned yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/no documents found/i)).not.toBeInTheDocument();
  });

  it("shows a distinct 'no documents found' state for a cloned repo with zero matching docs, never the not-cloned state (AC-5)", () => {
    const qc = buildClient();
    qc.setQueryData(["context", REPO_ID], []);

    render(wrap(<ContextScreen />, qc));

    expect(screen.getByText(/no documents found/i)).toBeInTheDocument();
    expect(screen.queryByText(/repo not cloned yet/i)).not.toBeInTheDocument();
  });
});

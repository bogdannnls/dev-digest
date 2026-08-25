import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../../../messages/en/agents.json";
import { AddContextDocPicker } from "./AddContextDocPicker";
import type { SpecFile } from "@devdigest/shared";

const REPO_ID = "repo-1111-1111-1111-111111111111";

const files: SpecFile[] = [
  { path: "specs/alpha.md", size: 10, updated_at: null },
  { path: "docs/beta.md", size: 20, updated_at: null },
];

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // AC-12b: the picker sources rows from GET /repos/:repoId/context for the
  // workspace's currently-active repo selection, seeded here via its query key.
  qc.setQueryData(["context", REPO_ID], files);
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

describe("AddContextDocPicker", () => {
  it("lists only documents NOT in attachedPaths", async () => {
    render(
      wrap(
        <AddContextDocPicker
          repoId={REPO_ID}
          attachedPaths={new Set(["specs/alpha.md"])}
          onPick={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.queryByText("specs/alpha.md")).not.toBeInTheDocument();
    });
    expect(screen.getByText("docs/beta.md")).toBeInTheDocument();
  });

  it("filters by search input", async () => {
    render(
      wrap(
        <AddContextDocPicker
          repoId={REPO_ID}
          attachedPaths={new Set()}
          onPick={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByText("specs/alpha.md")).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText(/search documents/i), "beta");
    expect(screen.queryByText("specs/alpha.md")).not.toBeInTheDocument();
    expect(screen.getByText("docs/beta.md")).toBeInTheDocument();
  });

  it("calls onPick then onClose when a row is clicked", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      wrap(
        <AddContextDocPicker
          repoId={REPO_ID}
          attachedPaths={new Set()}
          onPick={onPick}
          onClose={onClose}
        />,
      ),
    );
    await userEvent.click(await screen.findByText("specs/alpha.md"));
    expect(onPick).toHaveBeenCalledWith("specs/alpha.md");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the empty state when every discovered document is already attached", async () => {
    render(
      wrap(
        <AddContextDocPicker
          repoId={REPO_ID}
          attachedPaths={new Set(files.map((f) => f.path))}
          onPick={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    expect(
      await screen.findByText(/all discovered documents are already attached/i),
    ).toBeInTheDocument();
  });

  it("renders each row's kind badge, derived from its path (AC-43)", async () => {
    render(
      wrap(
        <AddContextDocPicker
          repoId={REPO_ID}
          attachedPaths={new Set()}
          onPick={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByText("specs/alpha.md")).toBeInTheDocument());
    expect(screen.getByText("specs")).toBeInTheDocument();
    expect(screen.getByText("docs")).toBeInTheDocument();
  });
});

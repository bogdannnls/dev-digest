import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { ApiError } from "@/lib/api";
import { ContextPreviewDrawer } from "./ContextPreviewDrawer";
import messages from "../../../messages/en/context.json";

vi.mock("@/lib/hooks/core", () => ({
  useContextFile: vi.fn(),
}));
import { useContextFile } from "@/lib/hooks/core";

const mockedUseContextFile = useContextFile as unknown as ReturnType<typeof vi.fn>;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{ context: messages }}>
      {node}
    </NextIntlClientProvider>
  );
}

describe("ContextPreviewDrawer", () => {
  it("renders the document content read-only, with its kind badge and path, and no edit affordance (AC-39)", () => {
    mockedUseContextFile.mockReturnValue({
      data: { path: "specs/2026-07-11-feature-spec.md", content: "## Heading\n\nsome spec body", size: 30, updated_at: null },
      error: null,
      isLoading: false,
    });

    render(
      wrap(
        <ContextPreviewDrawer repoId="repo-1" path="specs/2026-07-11-feature-spec.md" onClose={() => undefined} />,
      ),
    );

    expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument();
    expect(screen.getByText("specs/2026-07-11-feature-spec.md")).toBeInTheDocument();
    expect(screen.getByText("specs")).toBeInTheDocument();
    // Read-only: no edit control, no Toggle switch, no Dropdown kebab trigger.
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/more/i)).not.toBeInTheDocument();
  });

  it("shows an explicit not-found state (not a blank pane) when the path 404s (AC-40)", () => {
    mockedUseContextFile.mockReturnValue({
      data: undefined,
      error: new ApiError("Not Found", 404, "not_found"),
      isLoading: false,
    });

    render(wrap(<ContextPreviewDrawer repoId="repo-1" path="specs/deleted.md" onClose={() => undefined} />));

    expect(screen.getByText(/document not found/i)).toBeInTheDocument();
    expect(screen.getByText(/no longer exists/i)).toBeInTheDocument();
  });

  it("fires onClose when Escape is pressed", async () => {
    mockedUseContextFile.mockReturnValue({
      data: { path: "docs/readme.md", content: "content", size: 7, updated_at: null },
      error: null,
      isLoading: false,
    });
    const onClose = vi.fn();

    render(wrap(<ContextPreviewDrawer repoId="repo-1" path="docs/readme.md" onClose={onClose} />));
    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
  });
});

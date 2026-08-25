import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { DragEndEvent } from "@dnd-kit/core";
import { ContextSection } from "./ContextSection";
import skillsMessages from "../../../../../../../messages/en/skills.json";
import contextMessages from "../../../../../../../messages/en/context.json";

const hooksSpy = vi.hoisted(() => ({
  useContextFiles: vi.fn(),
  useContextFile: vi.fn(),
}));
vi.mock("@/lib/hooks/core", () => ({
  useContextFiles: hooksSpy.useContextFiles,
  useContextFile: hooksSpy.useContextFile,
}));

// jsdom does not support @dnd-kit's KeyboardSensor pointer/keyboard event loop
// (see client/INSIGHTS.md, 2026-06-23) — capture onDragEnd from the mocked
// DndContext and invoke it directly with synthetic {active, over} data.
let capturedOnDragEnd: ((e: DragEndEvent) => void) | undefined;
vi.mock("@dnd-kit/core", async (importActual) => {
  const actual = await importActual<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: { onDragEnd?: (e: DragEndEvent) => void; children?: React.ReactNode }) => {
      capturedOnDragEnd = props.onDragEnd;
      return <>{props.children}</>;
    },
  };
});

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{ skills: skillsMessages, context: contextMessages }}>
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  hooksSpy.useContextFiles.mockReset().mockReturnValue({
    data: [
      { path: "specs/2026-07-11-invariant.md", size: 100, updated_at: null },
      { path: "docs/architecture.md", size: 200, updated_at: null },
    ],
  });
  hooksSpy.useContextFile.mockReset().mockReturnValue({
    data: { path: "specs/2026-07-11-invariant.md", content: "## Invariant\n\nbody", size: 100, updated_at: null },
    error: null,
    isLoading: false,
  });
  capturedOnDragEnd = undefined;
});

describe("ContextSection", () => {
  it("renders attached docs with kind badges and a keyboard-accessible drag handle, without an aria-hidden handle", () => {
    render(
      wrap(
        <ContextSection
          repoId="repo-1"
          paths={["specs/2026-07-11-invariant.md", "docs/architecture.md"]}
          onChange={() => {}}
        />,
      ),
    );
    expect(screen.getByText("specs/2026-07-11-invariant.md")).toBeInTheDocument();
    expect(screen.getByText("docs/architecture.md")).toBeInTheDocument();
    const handles = screen.getAllByLabelText("Reorder document");
    expect(handles).toHaveLength(2);
    handles.forEach((h) => expect(h).not.toHaveAttribute("aria-hidden"));
  });

  it("drag-reorder calls onChange with the new path order", async () => {
    const onChange = vi.fn();
    render(
      wrap(
        <ContextSection
          repoId="repo-1"
          paths={["specs/2026-07-11-invariant.md", "docs/architecture.md"]}
          onChange={onChange}
        />,
      ),
    );
    expect(capturedOnDragEnd).toBeDefined();
    await act(async () => {
      capturedOnDragEnd!({
        active: { id: "specs/2026-07-11-invariant.md", data: { current: undefined }, rect: { current: { initial: null, translated: null } } },
        over: { id: "docs/architecture.md", data: { current: undefined }, rect: { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } },
        collisions: [],
        activatorEvent: new Event("pointerdown"),
        delta: { x: 0, y: 0 },
      } as unknown as DragEndEvent);
    });
    expect(onChange).toHaveBeenCalledWith(["docs/architecture.md", "specs/2026-07-11-invariant.md"]);
  });

  it("removing a row calls onChange without that path", async () => {
    const onChange = vi.fn();
    render(
      wrap(
        <ContextSection
          repoId="repo-1"
          paths={["specs/2026-07-11-invariant.md", "docs/architecture.md"]}
          onChange={onChange}
        />,
      ),
    );
    await userEvent.click(screen.getByLabelText("Remove specs/2026-07-11-invariant.md"));
    expect(onChange).toHaveBeenCalledWith(["docs/architecture.md"]);
  });

  it("Preview opens the read-only drawer showing the document's content", async () => {
    render(
      wrap(
        <ContextSection repoId="repo-1" paths={["specs/2026-07-11-invariant.md"]} onChange={() => {}} />,
      ),
    );
    await userEvent.click(screen.getByLabelText("Preview specs/2026-07-11-invariant.md"));
    expect(await screen.findByRole("heading", { name: "Invariant" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("Add document opens a picker sourced from useContextFiles, excluding already-attached paths; picking one appends it", async () => {
    const onChange = vi.fn();
    render(
      wrap(
        <ContextSection
          repoId="repo-1"
          paths={["specs/2026-07-11-invariant.md"]}
          onChange={onChange}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /add document/i }));
    expect(hooksSpy.useContextFiles).toHaveBeenCalledWith("repo-1");
    expect(screen.queryByText("specs/2026-07-11-invariant.md", { selector: "button *" })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByText("docs/architecture.md"));
    expect(onChange).toHaveBeenCalledWith(["specs/2026-07-11-invariant.md", "docs/architecture.md"]);
  });

  it("renders the no-active-repo empty state when repoId is null and nothing is attached yet", () => {
    hooksSpy.useContextFiles.mockReturnValue({ data: [] });
    render(wrap(<ContextSection repoId={null} paths={[]} onChange={() => {}} />));
    expect(screen.getByText(/no active repo selected/i)).toBeInTheDocument();
  });
});

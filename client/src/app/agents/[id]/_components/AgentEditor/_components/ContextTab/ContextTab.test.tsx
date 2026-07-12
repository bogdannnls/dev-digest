import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../messages/en/agents.json";
import contextMessages from "../../../../../../../../messages/en/context.json";
import { ContextTab } from "./ContextTab";
import type { Agent, AgentSkillLink, Skill, SpecFile } from "@devdigest/shared";
import type { DragEndEvent } from "@dnd-kit/core";

const REPO_ID = "repo-1111-1111-1111-111111111111";

// ContextTab reads the workspace's currently-active repo via useActiveRepo
// (AC-12b/AC-12c) — mocked as a boundary, mirroring how other tests mock
// hooks that depend on Next router/localStorage internals not present here.
vi.mock("@/lib/repo-context", () => ({
  useActiveRepo: () => ({
    repoId: REPO_ID,
    setRepoId: vi.fn(),
    repos: [],
    activeRepo: null,
    reposLoaded: true,
  }),
}));

const agent: Agent = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Test Agent",
  description: "",
  provider: "openai",
  model: "gpt-4o-mini",
  system_prompt: "review",
  output_schema: null,
  enabled: true,
  version: 1,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
  attached_context_paths: ["specs/a.md", "docs/b.md"],
};

const skills: Skill[] = [
  {
    id: "s-a",
    name: "skill-a",
    description: "",
    type: "rubric",
    source: "manual",
    body: "",
    enabled: true,
    version: 1,
    attached_context_paths: ["specs/a.md", "insights/only-a.md"],
  },
  {
    id: "s-b",
    name: "skill-b",
    description: "",
    type: "security",
    source: "manual",
    body: "",
    enabled: true,
    version: 1,
    attached_context_paths: ["docs/skill-b-only.md"],
  },
];

const links: AgentSkillLink[] = [
  { agent_id: agent.id, skill_id: "s-a", order: 0, enabled: true },
  { agent_id: agent.id, skill_id: "s-b", order: 1, enabled: false },
];

const discovered: SpecFile[] = [
  { path: "specs/a.md", size: 100, updated_at: null },
  { path: "docs/b.md", size: 50, updated_at: null },
  { path: "docs/new-doc.md", size: 20, updated_at: null },
];

function buildClient(agentLinks: AgentSkillLink[], allSkills: Skill[] = skills) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["agent-skills", agent.id], agentLinks);
  qc.setQueryData(["skills"], allSkills);
  qc.setQueryData(["context", REPO_ID], discovered);
  return qc;
}

function wrap(ui: React.ReactNode, qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages, context: contextMessages }}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

const apiSpy = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), del: vi.fn(), get: vi.fn(), put: vi.fn() }));
vi.mock("../../../../../../../lib/api", () => ({ api: apiSpy, ApiError: class extends Error {} }));

// jsdom does not support @dnd-kit's KeyboardSensor pointer/keyboard event loop
// (client/INSIGHTS.md, 2026-06-23) — drive handleDragEnd directly via a mock.
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

beforeEach(() => {
  apiSpy.post.mockReset().mockResolvedValue([]);
  apiSpy.patch.mockReset().mockResolvedValue([]);
  apiSpy.del.mockReset().mockResolvedValue([]);
  apiSpy.get.mockReset();
  apiSpy.put.mockReset().mockResolvedValue(agent);
  capturedOnDragEnd = undefined;
});

describe("ContextTab", () => {
  it("renders the empty state when no docs are attached and none inherited", () => {
    const noDocsAgent: Agent = { ...agent, attached_context_paths: [] };
    const qc = buildClient([], []);
    render(wrap(<ContextTab agent={noDocsAgent} />, qc));
    expect(screen.getByText(/no documents attached yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add document/i })).toBeInTheDocument();
  });

  it("renders own docs in order with kind badges, reorderable", () => {
    const qc = buildClient(links);
    render(wrap(<ContextTab agent={agent} />, qc));
    // own docs in array order
    expect(screen.getByText("specs/a.md")).toBeInTheDocument();
    expect(screen.getByText("docs/b.md")).toBeInTheDocument();
    // kind badges derived from path (AC-43)
    expect(screen.getAllByText("specs")).not.toHaveLength(0);
    expect(screen.getAllByText("docs").length).toBeGreaterThan(0);
    // own rows get a drag handle — one per own doc
    expect(screen.getAllByLabelText("Reorder document")).toHaveLength(2);
  });

  it("renders inherited docs visually distinct, with no drag handle and no remove action (AC-20/21)", () => {
    const qc = buildClient(links);
    render(wrap(<ContextTab agent={agent} />, qc));

    // s-a is enabled and contributes "insights/only-a.md" (its other path,
    // specs/a.md, is already in the agent's own list and must be deduped out).
    // s-b is disabled — its "docs/skill-b-only.md" must NOT appear at all.
    expect(screen.getByText(/inherited from enabled skills/i)).toBeInTheDocument();
    expect(screen.getByText("insights/only-a.md")).toBeInTheDocument();
    expect(screen.queryByText("docs/skill-b-only.md")).not.toBeInTheDocument();

    // Exactly two drag handles exist — one per OWN doc, none for the inherited one.
    expect(screen.getAllByLabelText("Reorder document")).toHaveLength(2);
    // No remove action for the inherited row.
    expect(
      screen.queryByRole("button", { name: /remove insights\/only-a\.md/i }),
    ).not.toBeInTheDocument();
    // Own rows do have a remove action.
    expect(screen.getByRole("button", { name: /remove specs\/a\.md/i })).toBeInTheDocument();
  });

  it("drag-reorder posts the new order via PUT /agents/:id with repo_id (AC-36)", async () => {
    const qc = buildClient(links);
    render(wrap(<ContextTab agent={agent} />, qc));

    expect(capturedOnDragEnd).toBeDefined();

    // Drag "specs/a.md" (index 0) onto "docs/b.md" (index 1).
    await act(async () => {
      capturedOnDragEnd!({
        active: { id: "specs/a.md", data: { current: undefined }, rect: { current: { initial: null, translated: null } } },
        over: { id: "docs/b.md", data: { current: undefined }, rect: { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } },
        collisions: [],
        activatorEvent: new Event("pointerdown"),
        delta: { x: 0, y: 0 },
      } as unknown as DragEndEvent);
    });

    await waitFor(() => {
      expect(apiSpy.put).toHaveBeenCalledWith(`/agents/${agent.id}`, {
        attached_context_paths: ["docs/b.md", "specs/a.md"],
        repo_id: REPO_ID,
      });
    });
  });

  it("remove action posts the filtered list via PUT", async () => {
    const qc = buildClient(links);
    render(wrap(<ContextTab agent={agent} />, qc));
    await userEvent.click(screen.getByRole("button", { name: /remove specs\/a\.md/i }));
    await waitFor(() => {
      expect(apiSpy.put).toHaveBeenCalledWith(`/agents/${agent.id}`, {
        attached_context_paths: ["docs/b.md"],
        repo_id: REPO_ID,
      });
    });
  });

  it("picking a document from the AddContextDocPicker posts the appended list via PUT (AC-12b)", async () => {
    const qc = buildClient(links);
    render(wrap(<ContextTab agent={agent} />, qc));
    await userEvent.click(screen.getByRole("button", { name: /add document/i }));
    await userEvent.click(await screen.findByText("docs/new-doc.md"));
    await waitFor(() => {
      expect(apiSpy.put).toHaveBeenCalledWith(`/agents/${agent.id}`, {
        attached_context_paths: ["specs/a.md", "docs/b.md", "docs/new-doc.md"],
        repo_id: REPO_ID,
      });
    });
  });

  it("clicking Preview on an own doc opens the read-only ContextPreviewDrawer for that path", async () => {
    const qc = buildClient(links);
    qc.setQueryData(["context-file", REPO_ID, "specs/a.md"], {
      path: "specs/a.md",
      content: "# invariant\napi/ must not import db/ directly",
      size: 100,
      updated_at: null,
    });
    render(wrap(<ContextTab agent={agent} />, qc));
    await userEvent.click(screen.getByRole("button", { name: /preview specs\/a\.md/i }));
    const drawer = screen.getByRole("dialog", { name: "specs/a.md" });
    expect(drawer).toBeInTheDocument();
    expect(await screen.findByText(/must not import db\/ directly/i)).toBeInTheDocument();
  });
});

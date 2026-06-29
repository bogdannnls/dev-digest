import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../messages/en/agents.json";
import { SkillsTab } from "./SkillsTab";
import type { Agent, AgentSkillLink, Skill } from "@devdigest/shared";
import type { DragEndEvent } from "@dnd-kit/core";
import * as agentsHooks from "@/lib/hooks/agents";

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
};

const skills: Skill[] = [
  { id: "s-a", name: "skill-a", description: "", type: "rubric", source: "manual", body: "", enabled: true, version: 1 },
  { id: "s-b", name: "skill-b", description: "", type: "security", source: "manual", body: "", enabled: true, version: 1 },
  { id: "s-c", name: "skill-c", description: "", type: "convention", source: "manual", body: "", enabled: true, version: 1 },
];

function buildClient(initialLinks: AgentSkillLink[], allSkills: Skill[] = skills) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["agent-skills", agent.id], initialLinks);
  qc.setQueryData(["skills"], allSkills);
  return qc;
}

function wrap(ui: React.ReactNode, qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

const apiSpy = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), del: vi.fn(), get: vi.fn(), put: vi.fn() }));
vi.mock("../../../../../../../lib/api", () => ({ api: apiSpy, ApiError: class extends Error {} }));

// We wrap only the three hooks used in the new Compare-button tests as vi.fn spies.
// The factory captures `actual` which gives us the real implementations;
// beforeEach restores them so existing QC-seeding tests are unaffected.
const _realAgentsHooks = vi.hoisted(() => ({
  useAgentSkills: undefined as any,
  useEvalFixtures: undefined as any,
  useSkillsEval: undefined as any,
}));

vi.mock("@/lib/hooks/agents", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/hooks/agents")>();
  _realAgentsHooks.useAgentSkills = actual.useAgentSkills;
  _realAgentsHooks.useEvalFixtures = actual.useEvalFixtures;
  _realAgentsHooks.useSkillsEval = actual.useSkillsEval;
  return {
    ...actual,
    useAgentSkills: vi.fn(actual.useAgentSkills),
    useEvalFixtures: vi.fn(actual.useEvalFixtures),
    useSkillsEval: vi.fn(actual.useSkillsEval),
  };
});

// Capture the onDragEnd handler from DndContext so we can fire it directly.
// jsdom does not provide a real pointer/keyboard event loop, so driving
// @dnd-kit's KeyboardSensor via userEvent.keyboard is unreliable in unit tests.
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
  apiSpy.put.mockReset();
  capturedOnDragEnd = undefined;
  // Restore agents hook spies to real implementations between tests.
  // QC-based tests rely on the real hooks reading from QueryClient cache.
  vi.mocked(agentsHooks.useAgentSkills).mockImplementation(_realAgentsHooks.useAgentSkills);
  vi.mocked(agentsHooks.useEvalFixtures).mockImplementation(_realAgentsHooks.useEvalFixtures);
  vi.mocked(agentsHooks.useSkillsEval).mockImplementation(_realAgentsHooks.useSkillsEval);
});

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["skills"], skills);
  return render(wrap(<SkillsTab agent={agent} />, qc));
}

describe("SkillsTab", () => {
  it("renders the empty state when no skills are linked", () => {
    const qc = buildClient([]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    expect(screen.getByText(/no skills linked yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add skill/i })).toBeInTheDocument();
  });

  it("renders linked rows in `order` ascending", () => {
    const qc = buildClient([
      { agent_id: agent.id, skill_id: "s-b", order: 0, enabled: true },
      { agent_id: agent.id, skill_id: "s-a", order: 1, enabled: false },
    ]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    const names = screen.getAllByText(/^skill-/).map((el) => el.textContent);
    expect(names).toEqual(["skill-b", "skill-a"]);
  });

  it("the {enabled} of {total} pill updates with the linked array", () => {
    const qc = buildClient([
      { agent_id: agent.id, skill_id: "s-a", order: 0, enabled: true },
      { agent_id: agent.id, skill_id: "s-b", order: 1, enabled: false },
    ]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    expect(screen.getByText("1 of 2 enabled")).toBeInTheDocument();
  });

  it("toggling a checkbox calls PATCH and flips optimistically", async () => {
    const link = { agent_id: agent.id, skill_id: "s-a", order: 0, enabled: true };
    const qc = buildClient([link]);
    // Return the updated link so onSuccess doesn't wipe the cache
    apiSpy.patch.mockResolvedValue([{ ...link, enabled: false }]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    await userEvent.click(screen.getByRole("checkbox", { name: /skill-a/i }));
    await waitFor(() => {
      expect(apiSpy.patch).toHaveBeenCalledWith(
        `/agents/${agent.id}/skills/s-a`,
        { enabled: false },
      );
    });
    expect(screen.getByRole("checkbox", { name: /skill-a/i })).not.toBeChecked();
  });

  it("kebab → Remove fires DELETE", async () => {
    const qc = buildClient([
      { agent_id: agent.id, skill_id: "s-a", order: 0, enabled: true },
    ]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /remove from agent/i }));
    expect(apiSpy.del).toHaveBeenCalledWith(`/agents/${agent.id}/skills/s-a`);
  });

  it("clicking a picker row fires POST { skill_id }", async () => {
    const qc = buildClient([]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    await userEvent.click(screen.getByRole("button", { name: /add skill/i }));
    await userEvent.click(await screen.findByText("skill-a"));
    expect(apiSpy.post).toHaveBeenCalledWith(
      `/agents/${agent.id}/skills`,
      { skill_id: "s-a" },
    );
  });

  it("filter input narrows visible rows by name", async () => {
    const qc = buildClient([
      { agent_id: agent.id, skill_id: "s-a", order: 0, enabled: true },
      { agent_id: agent.id, skill_id: "s-b", order: 1, enabled: true },
    ]);
    render(wrap(<SkillsTab agent={agent} />, qc));
    await userEvent.type(screen.getByPlaceholderText(/filter skills/i), "skill-b");
    expect(screen.queryByText("skill-a")).not.toBeInTheDocument();
    expect(screen.getByText("skill-b")).toBeInTheDocument();
  });

  it("renders Compare button enabled when ≥1 link is enabled", () => {
    vi.mocked(agentsHooks.useAgentSkills).mockReturnValue({
      data: [{ skill_id: "s-a", enabled: true, order: 0, agent_id: agent.id }],
      isLoading: false,
    } as any);
    renderTab();
    expect(screen.getByRole("button", { name: /compare with vs without skills/i })).toBeEnabled();
  });

  it("disables Compare button when no enabled links", () => {
    vi.mocked(agentsHooks.useAgentSkills).mockReturnValue({
      data: [{ skill_id: "s-a", enabled: false, order: 0, agent_id: agent.id }],
      isLoading: false,
    } as any);
    renderTab();
    expect(screen.getByRole("button", { name: /compare with vs without skills/i })).toBeDisabled();
  });

  it("opens the modal on click", async () => {
    vi.mocked(agentsHooks.useAgentSkills).mockReturnValue({
      data: [{ skill_id: "s-a", enabled: true, order: 0, agent_id: agent.id }],
      isLoading: false,
    } as any);
    vi.mocked(agentsHooks.useEvalFixtures).mockReturnValue({ data: [{ id: "a", title: "Alpha" }], isLoading: false } as any);
    vi.mocked(agentsHooks.useSkillsEval).mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, data: undefined, reset: vi.fn() } as any);
    renderTab();
    await userEvent.click(screen.getByRole("button", { name: /compare with vs without skills/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("drag-reorder fires POST { skill_ids } in the new order", async () => {
    // NOTE: jsdom does not support @dnd-kit's KeyboardSensor pointer/keyboard event
    // loop, so we drive handleDragEnd directly via the DndContext mock above.
    const qc = buildClient([
      { agent_id: agent.id, skill_id: "s-a", order: 0, enabled: true },
      { agent_id: agent.id, skill_id: "s-b", order: 1, enabled: true },
    ]);
    apiSpy.post.mockResolvedValueOnce([
      { agent_id: agent.id, skill_id: "s-b", order: 0, enabled: true },
      { agent_id: agent.id, skill_id: "s-a", order: 1, enabled: true },
    ]);
    render(wrap(<SkillsTab agent={agent} />, qc));

    // DndContext mock captures onDragEnd during render.
    expect(capturedOnDragEnd).toBeDefined();

    // Simulate dragging s-a (index 0) onto s-b (index 1) — net move: s-a moves down.
    await act(async () => {
      capturedOnDragEnd!({
        active: { id: "s-a", data: { current: undefined }, rect: { current: { initial: null, translated: null } } },
        over: { id: "s-b", data: { current: undefined }, rect: { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 } },
        collisions: [],
        activatorEvent: new Event("pointerdown"),
        delta: { x: 0, y: 0 },
      } as unknown as DragEndEvent);
    });

    await waitFor(() => {
      expect(apiSpy.post).toHaveBeenCalledWith(
        `/agents/${agent.id}/skills`,
        { skill_ids: ["s-b", "s-a"] },
      );
    });
  });
});

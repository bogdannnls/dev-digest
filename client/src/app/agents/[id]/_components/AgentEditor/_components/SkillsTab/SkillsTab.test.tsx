import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../messages/en/agents.json";
import { SkillsTab } from "./SkillsTab";
import type { Agent, AgentSkillLink, Skill } from "@devdigest/shared";

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

beforeEach(() => {
  apiSpy.post.mockReset().mockResolvedValue([]);
  apiSpy.patch.mockReset().mockResolvedValue([]);
  apiSpy.del.mockReset().mockResolvedValue([]);
  apiSpy.get.mockReset();
  apiSpy.put.mockReset();
});

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
});

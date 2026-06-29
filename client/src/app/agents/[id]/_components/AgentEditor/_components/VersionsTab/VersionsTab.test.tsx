import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../messages/en/agents.json";
import { VersionsTab } from "./VersionsTab";
import type { Agent, AgentVersion, Skill } from "@devdigest/shared";

const agent: Agent = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Test Agent",
  description: "",
  provider: "openai",
  model: "gpt-4o-mini",
  system_prompt: "current prompt",
  output_schema: null,
  enabled: true,
  version: 2,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
};

const skills: Skill[] = [
  { id: "s-a", name: "skill-a", description: "", type: "rubric", source: "manual", body: "", enabled: true, version: 1 },
  { id: "s-b", name: "skill-b", description: "", type: "security", source: "manual", body: "", enabled: true, version: 1 },
];

const v1: AgentVersion = {
  agent_id: agent.id,
  version: 1,
  created_at: "2026-06-20T12:00:00Z",
  config: {
    provider: "openai",
    model: "gpt-4o-mini",
    system_prompt: "older prompt",
    output_schema: null,
    strategy: "single-pass",
    ci_fail_on: "critical",
    repo_intel: false,
    skills: ["s-a", "s-deleted"],
  },
};

const v2: AgentVersion = {
  agent_id: agent.id,
  version: 2,
  created_at: "2026-06-23T15:30:00Z",
  config: {
    provider: "openai",
    model: "gpt-4o-mini",
    system_prompt: "current prompt",
    output_schema: null,
    strategy: "single-pass",
    ci_fail_on: "critical",
    repo_intel: true,
    skills: ["s-a", "s-b"],
  },
};

function buildClient(seeds: {
  versions?: AgentVersion[] | "loading" | "error";
  skills?: Skill[];
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (seeds.versions && seeds.versions !== "loading" && seeds.versions !== "error") {
    qc.setQueryData(["agent-versions", agent.id], seeds.versions);
  }
  qc.setQueryData(["skills"], seeds.skills ?? skills);
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

const apiSpy = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock("../../../../../../../lib/api", () => ({ api: apiSpy, ApiError: class extends Error {} }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VersionsTab", () => {
  it("renders both rows newest-first with the current badge on v2", () => {
    const qc = buildClient({ versions: [v2, v1] });
    render(wrap(<VersionsTab agent={agent} />, qc));

    expect(screen.getByText("Version history")).toBeInTheDocument();
    expect(screen.getByText("2 versions")).toBeInTheDocument();

    const headers = screen.getAllByRole("button", { expanded: false });
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent("v2");
    expect(headers[1]).toHaveTextContent("v1");

    // current badge appears once, on the v2 row
    const currentBadges = screen.getAllByText("current");
    expect(currentBadges).toHaveLength(1);
    expect(headers[0]).toContainElement(currentBadges[0]);
  });

  it("expands a row to show config fields and the snapshot prompt", async () => {
    const user = userEvent.setup();
    const qc = buildClient({ versions: [v2, v1] });
    render(wrap(<VersionsTab agent={agent} />, qc));

    const v1Header = screen.getByRole("button", { name: /v1/ });
    await user.click(v1Header);

    expect(screen.getByText("Provider")).toBeInTheDocument();
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("Repo intel")).toBeInTheDocument();
    expect(screen.getByText("off")).toBeInTheDocument();
    expect(screen.getByText("older prompt")).toBeInTheDocument();
  });

  it("resolves known skill ids to names and falls back to id with (deleted) for unknown ids", async () => {
    const user = userEvent.setup();
    const qc = buildClient({ versions: [v2, v1] });
    render(wrap(<VersionsTab agent={agent} />, qc));

    await user.click(screen.getByRole("button", { name: /v1/ }));

    // v1 has skills: ['s-a', 's-deleted']
    expect(screen.getByText("skill-a")).toBeInTheDocument();
    expect(screen.getByText("s-deleted")).toBeInTheDocument();
    expect(screen.getByText("(deleted)")).toBeInTheDocument();
  });

  it("shows the 'only one version' note when the agent has exactly one snapshot", () => {
    const onlyV1 = { ...v1, version: 1 };
    const qc = buildClient({ versions: [onlyV1] });
    render(wrap(<VersionsTab agent={{ ...agent, version: 1 }} />, qc));

    expect(screen.getByText(/Only one version so far/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /v1/ })).not.toBeInTheDocument();
  });

  it("renders the error state when the query fails", async () => {
    apiSpy.get.mockRejectedValueOnce(new Error("boom"));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["skills"], skills);
    render(wrap(<VersionsTab agent={agent} />, qc));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load version history.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});

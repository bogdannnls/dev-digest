import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { SkillsListView } from "./SkillsListView";
import * as skillsHooks from "../../../../lib/hooks/skills";
import messages from "../../../../../messages/en/skills.json";
import type { Skill } from "@devdigest/shared";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("../../../../lib/hooks/skills");

vi.mock("../../../../components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function wrap(node: React.ReactNode) {
  const qc = new QueryClient();
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

const ONE: Skill = {
  id: "1",
  name: "secret-leakage-gate",
  description: "x",
  type: "security",
  source: "manual",
  body: "",
  enabled: true,
  version: 1,
  evidence_files: null,
};

describe("SkillsListView", () => {
  beforeEach(() => {
    vi.mocked(skillsHooks.useSkills).mockReturnValue({ data: [], isLoading: false, isError: false } as any);
    vi.mocked(skillsHooks.useUpdateSkill).mockReturnValue({ mutate: vi.fn() } as any);
  });

  it("shows the empty state when there are no skills", () => {
    render(wrap(<SkillsListView />));
    expect(screen.getByText("No skills yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create your first skill/i })).toBeInTheDocument();
  });

  it("renders a card per skill when the list is non-empty", () => {
    vi.mocked(skillsHooks.useSkills).mockReturnValueOnce({ data: [ONE], isLoading: false, isError: false } as any);
    render(wrap(<SkillsListView />));
    expect(screen.getByText("secret-leakage-gate")).toBeInTheDocument();
  });
});

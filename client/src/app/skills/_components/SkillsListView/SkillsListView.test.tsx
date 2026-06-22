import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { SkillsListView } from "./SkillsListView";
import messages from "../../../../../messages/en/skills.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("../../../../lib/hooks/skills", () => ({
  useSkills: () => ({ data: [], isLoading: false, isError: false }),
  useUpdateSkill: () => ({ mutate: vi.fn() }),
}));

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

describe("SkillsListView", () => {
  it("shows the empty state when there are no skills", () => {
    render(wrap(<SkillsListView />));
    expect(screen.getByText("No skills yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create your first skill/i })).toBeInTheDocument();
  });
});

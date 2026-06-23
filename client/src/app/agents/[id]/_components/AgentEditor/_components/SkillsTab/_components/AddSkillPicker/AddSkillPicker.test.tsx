import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../../../messages/en/agents.json";
import { AddSkillPicker } from "./AddSkillPicker";
import type { Skill } from "@devdigest/shared";

const skills: Skill[] = [
  {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    name: "alpha-rubric",
    description: "",
    type: "rubric",
    source: "manual",
    body: "",
    enabled: true,
    version: 1,
  },
  {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    name: "beta-security",
    description: "",
    type: "security",
    source: "manual",
    body: "",
    enabled: true,
    version: 1,
  },
];

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["skills"], skills);
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

describe("AddSkillPicker", () => {
  it("lists only skills NOT in linkedIds", async () => {
    render(
      wrap(
        <AddSkillPicker
          linkedIds={new Set(["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"])}
          onPick={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.queryByText("alpha-rubric")).not.toBeInTheDocument();
    });
    expect(screen.getByText("beta-security")).toBeInTheDocument();
  });

  it("filters by search input", async () => {
    render(
      wrap(
        <AddSkillPicker linkedIds={new Set()} onPick={() => {}} onClose={() => {}} />,
      ),
    );
    await waitFor(() => expect(screen.getByText("alpha-rubric")).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText(/search skills/i), "beta");
    expect(screen.queryByText("alpha-rubric")).not.toBeInTheDocument();
    expect(screen.getByText("beta-security")).toBeInTheDocument();
  });

  it("calls onPick then onClose when a row is clicked", async () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      wrap(<AddSkillPicker linkedIds={new Set()} onPick={onPick} onClose={onClose} />),
    );
    await userEvent.click(await screen.findByText("alpha-rubric"));
    expect(onPick).toHaveBeenCalledWith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the empty state when 0 unlinked", async () => {
    render(
      wrap(
        <AddSkillPicker
          linkedIds={new Set(skills.map((s) => s.id))}
          onPick={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    expect(
      await screen.findByText(/all workspace skills are already linked/i),
    ).toBeInTheDocument();
  });
});

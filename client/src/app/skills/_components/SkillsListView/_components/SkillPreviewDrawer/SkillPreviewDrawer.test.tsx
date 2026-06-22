import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { SkillPreviewDrawer } from "./SkillPreviewDrawer";
import messages from "../../../../../../../messages/en/skills.json";
import type { Skill } from "@devdigest/shared";

const sample: Skill = {
  id: "1",
  name: "secret-leakage-gate",
  description: "Flag committed secrets",
  type: "security",
  source: "manual",
  body: "## Heading\n\nflag secrets",
  enabled: true,
  version: 1,
  evidence_files: null,
};

vi.mock("../../../../../../lib/hooks/skills", () => ({
  useSkill: () => ({ data: sample, isLoading: false }),
  useSkillUsage: () => ({ data: { agent_count: 0 } }),
  useUpdateSkill: () => ({ mutate: vi.fn() }),
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

describe("SkillPreviewDrawer", () => {
  it("renders the markdown body via react-markdown", () => {
    render(
      wrap(
        <SkillPreviewDrawer
          skillId="1"
          onClose={() => undefined}
          onEdit={() => undefined}
          onDeleteRequest={() => undefined}
        />,
      ),
    );
    expect(screen.getByRole("heading", { name: "Heading" })).toBeInTheDocument();
  });

  it("fires onEdit when the Edit button is clicked", async () => {
    const onEdit = vi.fn();
    render(
      wrap(
        <SkillPreviewDrawer
          skillId="1"
          onClose={() => undefined}
          onEdit={onEdit}
          onDeleteRequest={() => undefined}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /Edit/i }));
    expect(onEdit).toHaveBeenCalledWith("1");
  });

  it("fires onClose when Escape is pressed", async () => {
    const onClose = vi.fn();
    render(
      wrap(
        <SkillPreviewDrawer
          skillId="1"
          onClose={onClose}
          onEdit={() => undefined}
          onDeleteRequest={() => undefined}
        />,
      ),
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("fires onDeleteRequest when the kebab → Delete is chosen", async () => {
    const onDeleteRequest = vi.fn();
    render(
      wrap(
        <SkillPreviewDrawer
          skillId="1"
          onClose={() => undefined}
          onEdit={() => undefined}
          onDeleteRequest={onDeleteRequest}
        />,
      ),
    );
    await userEvent.click(screen.getByLabelText("more"));
    await userEvent.click(screen.getByText(/Delete…/));
    expect(onDeleteRequest).toHaveBeenCalledWith("1");
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../../../messages/en/agents.json";
import { LinkedSkillRow } from "./LinkedSkillRow";
import type { Skill } from "@devdigest/shared";

const skill: Skill = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "alpha-row",
  description: "",
  type: "security",
  source: "manual",
  body: "## body",
  enabled: true,
  version: 1,
};

function wrap(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
      {ui}
    </NextIntlClientProvider>
  );
}

describe("LinkedSkillRow", () => {
  it("renders the name and the type badge", () => {
    render(
      wrap(
        <LinkedSkillRow
          skill={skill}
          enabled={true}
          onToggleEnabled={() => {}}
          onRemove={() => {}}
        />,
      ),
    );
    expect(screen.getByText("alpha-row")).toBeInTheDocument();
    expect(screen.getByText(/security/i)).toBeInTheDocument();
  });

  it("checkbox aria-checked reflects enabled", () => {
    render(
      wrap(
        <LinkedSkillRow
          skill={skill}
          enabled={false}
          onToggleEnabled={() => {}}
          onRemove={() => {}}
        />,
      ),
    );
    const cb = screen.getByRole("checkbox", { name: /alpha-row/i });
    expect(cb).not.toBeChecked();
  });

  it("fires onToggleEnabled when the checkbox is clicked", async () => {
    const onToggle = vi.fn();
    render(
      wrap(
        <LinkedSkillRow
          skill={skill}
          enabled={false}
          onToggleEnabled={onToggle}
          onRemove={() => {}}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("checkbox", { name: /alpha-row/i }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("fires onRemove from the kebab menu", async () => {
    const onRemove = vi.fn();
    render(
      wrap(
        <LinkedSkillRow
          skill={skill}
          enabled={true}
          onToggleEnabled={() => {}}
          onRemove={onRemove}
        />,
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: /more/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: /remove from agent/i }));
    expect(onRemove).toHaveBeenCalled();
  });
});

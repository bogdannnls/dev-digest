import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { SkillCard } from "./SkillCard";
import messages from "../../../../../../../messages/en/skills.json";
import type { Skill } from "@devdigest/shared";

const sample: Skill = {
  id: "1",
  name: "secret-leakage-gate",
  description: "Flag committed secrets",
  type: "security",
  source: "manual",
  body: "...",
  enabled: true,
  version: 1,
  evidence_files: null,
};

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
      {node}
    </NextIntlClientProvider>
  );
}

describe("SkillCard", () => {
  it("renders name, description, and type label", () => {
    render(wrap(<SkillCard skill={sample} />));
    expect(screen.getByText("secret-leakage-gate")).toBeInTheDocument();
    expect(screen.getByText("Flag committed secrets")).toBeInTheDocument();
    expect(screen.getByText("Security")).toBeInTheDocument();
  });

  it("fires onClick when the card body is clicked", async () => {
    const onClick = vi.fn();
    render(wrap(<SkillCard skill={sample} onClick={onClick} />));
    await userEvent.click(screen.getByRole("button", { name: /secret-leakage-gate/i }));
    expect(onClick).toHaveBeenCalled();
  });

  it("fires onToggle and does NOT fire onClick when the toggle is clicked", async () => {
    const onClick = vi.fn();
    const onToggle = vi.fn();
    render(wrap(<SkillCard skill={sample} onClick={onClick} onToggle={onToggle} />));
    await userEvent.click(screen.getByRole("switch"));
    expect(onToggle).toHaveBeenCalledWith(false);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders disabled skills dimmed", () => {
    render(wrap(<SkillCard skill={{ ...sample, enabled: false }} />));
    const card = screen.getByRole("button", { name: /secret-leakage-gate/i });
    expect(card).toHaveStyle({ opacity: "0.55" });
  });
});

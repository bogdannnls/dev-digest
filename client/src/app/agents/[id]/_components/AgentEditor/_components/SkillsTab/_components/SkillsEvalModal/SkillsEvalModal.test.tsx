import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../../../messages/en/agents.json";
import { SkillsEvalModal } from "./SkillsEvalModal";
import * as agentsHooks from "@/lib/hooks/agents";

vi.mock("@/lib/hooks/agents");

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

const result = {
  fixture: { id: "a", title: "Alpha" },
  with_skills: {
    findings: [],
    grounding: "0/0",
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
  },
  without_skills: {
    findings: [],
    grounding: "0/0",
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
  },
};

describe("SkillsEvalModal", () => {
  beforeEach(() => {
    vi.mocked(agentsHooks.useEvalFixtures).mockReturnValue({
      data: [{ id: "a", title: "Alpha" }],
      isLoading: false,
    } as ReturnType<typeof agentsHooks.useEvalFixtures>);
  });

  it("renders picker state initially", () => {
    vi.mocked(agentsHooks.useSkillsEval).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      data: undefined,
      reset: vi.fn(),
    } as any);

    render(wrap(<SkillsEvalModal agentId="x" open onClose={() => {}} />));
    expect(
      screen.getByRole("button", { name: /run comparison/i }),
    ).toBeInTheDocument();
  });

  it("Run fires the mutation with the selected fixture", async () => {
    const mutate = vi.fn();
    vi.mocked(agentsHooks.useSkillsEval).mockReturnValue({
      mutate,
      isPending: false,
      isError: false,
      data: undefined,
      reset: vi.fn(),
    } as any);

    render(wrap(<SkillsEvalModal agentId="x" open onClose={() => {}} />));
    await userEvent.click(screen.getByRole("button", { name: /run comparison/i }));
    expect(mutate).toHaveBeenCalledWith({ fixture_id: "a" });
  });

  it("shows running state when isPending", () => {
    vi.mocked(agentsHooks.useSkillsEval).mockReturnValue({
      mutate: vi.fn(),
      isPending: true,
      isError: false,
      data: undefined,
      reset: vi.fn(),
    } as any);

    render(wrap(<SkillsEvalModal agentId="x" open onClose={() => {}} />));
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  it("shows results state when data is returned", () => {
    vi.mocked(agentsHooks.useSkillsEval).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
      data: result,
      reset: vi.fn(),
    } as any);

    render(wrap(<SkillsEvalModal agentId="x" open onClose={() => {}} />));
    expect(screen.getByTestId("with-column")).toBeInTheDocument();
    expect(screen.getByTestId("without-column")).toBeInTheDocument();
  });

  it("shows error + Retry when isError", async () => {
    const mutate = vi.fn();
    vi.mocked(agentsHooks.useSkillsEval).mockReturnValue({
      mutate,
      isPending: false,
      isError: true,
      data: undefined,
      reset: vi.fn(),
    } as any);

    render(wrap(<SkillsEvalModal agentId="x" open onClose={() => {}} />));
    expect(screen.getByText(/could not run/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(mutate).toHaveBeenCalled();
  });
});

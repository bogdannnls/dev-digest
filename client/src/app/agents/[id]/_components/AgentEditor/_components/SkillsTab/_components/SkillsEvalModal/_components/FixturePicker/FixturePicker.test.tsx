import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../../../../../messages/en/agents.json";
import { FixturePicker } from "./FixturePicker";
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

describe("FixturePicker", () => {
  it("renders fixtures and fires onChange", async () => {
    vi.mocked(agentsHooks.useEvalFixtures).mockReturnValue({
      data: [
        { id: "a", title: "Alpha" },
        { id: "b", title: "Beta" },
      ],
      isLoading: false,
    } as ReturnType<typeof agentsHooks.useEvalFixtures>);

    const onChange = vi.fn();
    render(wrap(<FixturePicker value="a" onChange={onChange} />));

    await userEvent.selectOptions(screen.getByRole("combobox"), "b");
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("shows noFixtures message when list is empty", () => {
    vi.mocked(agentsHooks.useEvalFixtures).mockReturnValue({
      data: [] as { id: string; title: string; notes?: string }[],
      isLoading: false,
    } as unknown as ReturnType<typeof agentsHooks.useEvalFixtures>);

    render(wrap(<FixturePicker value={null} onChange={() => {}} />));
    expect(screen.getByText("No fixtures available.")).toBeInTheDocument();
  });
});

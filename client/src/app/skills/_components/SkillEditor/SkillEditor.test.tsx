import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { SkillEditor } from "./SkillEditor";
import messages from "../../../../../messages/en/skills.json";

const create = vi.fn((_input: any) => Promise.resolve({ id: "new-id", version: 1 }));
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useParams: () => ({}),
}));

vi.mock("../../../../components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../../../lib/hooks/skills", () => {
  const createSkillMock = () => {
    return {
      mutate: (input: any, options?: any) => {
        create(input).then((result) => {
          if (options?.onSuccess) {
            // Cast to any to bypass TypeScript's overly strict option handling
            (options.onSuccess as Function)(result);
          }
        });
      },
      isPending: false,
    };
  };
  return {
    useSkill: () => ({ data: undefined, isLoading: false, isError: false }),
    useCreateSkill: createSkillMock,
    useUpdateSkill: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

vi.mock("../../../../lib/toast", () => ({ useToast: () => ({ success: vi.fn() }) }));

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

describe("SkillEditor (create mode)", () => {
  it("disables the Create button until name is non-empty", async () => {
    render(wrap(<SkillEditor mode="create" />));
    const createButton = screen.getByRole("button", { name: /Create skill/i });
    expect(createButton).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText("secret-leakage-gate"), "secret-leakage-gate");
    expect(createButton).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/## When to flag/), "body");
    expect(createButton).toBeEnabled();
  });

  it("submits + navigates to the new skill's edit route", async () => {
    render(wrap(<SkillEditor mode="create" />));
    await userEvent.type(screen.getByPlaceholderText("secret-leakage-gate"), "x");
    await userEvent.type(screen.getByPlaceholderText(/## When to flag/), "body");
    await userEvent.click(screen.getByRole("button", { name: /Create skill/i }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "x", body: "body", type: "custom" })));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/skills/new-id"));
  });
});

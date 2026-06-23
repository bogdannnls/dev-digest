import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { ImportSkillDialog } from "./ImportSkillDialog";
import * as skillsHooks from "../../../../../../lib/hooks/skills";
import messages from "../../../../../../../messages/en/skills.json";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("../../../../../../lib/hooks/skills");

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ skills: messages }}>
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

function makeFile(name = "thing.md", body = "# Thing\n\nBody.") {
  return new File([body], name, { type: "text/markdown" });
}

const PREVIEW = {
  name: "thing",
  description: "Body",
  type: "custom" as const,
  body: "# Thing\n\nBody.",
  warnings: [],
};

describe("ImportSkillDialog", () => {
  beforeEach(() => {
    pushMock.mockReset();
    vi.mocked(skillsHooks.useImportSkillPreview).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue(PREVIEW),
      isPending: false,
      isError: false,
      error: null,
      reset: vi.fn(),
    } as any);
    vi.mocked(skillsHooks.useCreateSkill).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue({ id: "new-id" }),
      isPending: false,
    } as any);
  });

  it("returns null when not open", () => {
    const { container } = render(wrap(<ImportSkillDialog open={false} onClose={() => {}} />));
    expect(container.firstChild).toBeNull();
  });

  it("renders the file picker initially", () => {
    render(wrap(<ImportSkillDialog open={true} onClose={() => {}} />));
    expect(screen.getByText(/Import a skill/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Choose a .md file/i)).toBeInTheDocument();
  });

  it("transitions to the preview state after a successful upload", async () => {
    render(wrap(<ImportSkillDialog open={true} onClose={() => {}} />));
    const input = screen.getByLabelText(/Choose a .md file/i) as HTMLInputElement;
    await userEvent.upload(input, makeFile());
    await waitFor(() => expect(screen.getByText(/someone else's instructions/i)).toBeInTheDocument());
    expect(screen.getByDisplayValue("thing")).toBeInTheDocument();
  });

  it("renders parser warnings as chips", async () => {
    vi.mocked(skillsHooks.useImportSkillPreview).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue({ ...PREVIEW, warnings: ["Unknown type \"x\" — coerced to custom."] }),
      isPending: false,
      isError: false,
      error: null,
      reset: vi.fn(),
    } as any);
    render(wrap(<ImportSkillDialog open={true} onClose={() => {}} />));
    await userEvent.upload(screen.getByLabelText(/Choose a .md file/i) as HTMLInputElement, makeFile());
    await waitFor(() => expect(screen.getByText(/Heads up:/i)).toBeInTheDocument());
    expect(screen.getByText(/coerced to custom/i)).toBeInTheDocument();
  });

  it("calls useCreateSkill with source 'imported_url' and navigates on success", async () => {
    const createMutateAsync = vi.fn().mockResolvedValue({ id: "new-id" });
    vi.mocked(skillsHooks.useCreateSkill).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: createMutateAsync,
      isPending: false,
    } as any);
    render(wrap(<ImportSkillDialog open={true} onClose={() => {}} />));
    await userEvent.upload(screen.getByLabelText(/Choose a .md file/i) as HTMLInputElement, makeFile());
    await waitFor(() => screen.getByText(/someone else's instructions/i));
    await userEvent.click(screen.getByRole("button", { name: /Create skill/i }));
    await waitFor(() => {
      expect(createMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ name: "thing", source: "imported_url", body: "# Thing\n\nBody." }),
      );
    });
    expect(pushMock).toHaveBeenCalledWith("/skills/new-id");
  });

  it("shows an inline error when the preview upload fails", async () => {
    vi.mocked(skillsHooks.useImportSkillPreview).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockRejectedValue(new Error("boom")),
      isPending: false,
      isError: true,
      error: new Error("boom"),
      reset: vi.fn(),
    } as any);
    render(wrap(<ImportSkillDialog open={true} onClose={() => {}} />));
    await userEvent.upload(screen.getByLabelText(/Choose a .md file/i) as HTMLInputElement, makeFile());
    await waitFor(() => expect(screen.getByText(/couldn't parse the file/i)).toBeInTheDocument());
  });

  it("Cancel calls onClose without saving", async () => {
    const onClose = vi.fn();
    const createMutateAsync = vi.fn().mockResolvedValue({ id: "new-id" });
    vi.mocked(skillsHooks.useCreateSkill).mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: createMutateAsync,
      isPending: false,
    } as any);
    render(wrap(<ImportSkillDialog open={true} onClose={onClose} />));
    await userEvent.upload(screen.getByLabelText(/Choose a .md file/i) as HTMLInputElement, makeFile());
    await waitFor(() => screen.getByText(/someone else's instructions/i));
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(createMutateAsync).not.toHaveBeenCalled();
  });
});

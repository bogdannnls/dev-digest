import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { SkillEditor } from "./SkillEditor";
import messages from "../../../../../messages/en/skills.json";

const create = vi.fn((_input: any) => Promise.resolve({ id: "new-id", version: 1 }));
const push = vi.fn();

const hooksSpy = vi.hoisted(() => ({
  useSkill: vi.fn(),
  updateMutate: vi.fn(),
}));

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
        }).catch(() => {
          if (options?.onError) {
            (options.onError as Function)();
          }
        });
      },
      isPending: false,
    };
  };
  return {
    useSkill: hooksSpy.useSkill,
    useCreateSkill: createSkillMock,
    useUpdateSkill: () => ({ mutate: hooksSpy.updateMutate, isPending: false }),
  };
});

vi.mock("../../../../lib/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

vi.mock("../../../../lib/repo-context", () => ({
  useActiveRepo: () => ({ repoId: "repo-1", setRepoId: vi.fn(), repos: [], activeRepo: null, reposLoaded: true }),
}));

// ContextSection has its own dedicated test suite (ContextSection.test.tsx) —
// stub it here so this file only asserts SkillEditor's wiring: what it passes
// in, and what it does with onChange, not ContextSection's own internals.
vi.mock("./_components/ContextSection", () => ({
  ContextSection: ({ repoId, paths, onChange }: { repoId: string | null; paths: string[]; onChange: (next: string[]) => void }) => (
    <div>
      <span>context-section-repo:{repoId ?? "none"}</span>
      <span>context-section-paths:{paths.join(",")}</span>
      <button onClick={() => onChange([...paths, "docs/new.md"])}>attach docs/new.md</button>
    </div>
  ),
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

beforeEach(() => {
  hooksSpy.useSkill.mockReset().mockReturnValue({ data: undefined, isLoading: false, isError: false });
  hooksSpy.updateMutate.mockReset();
});

describe("SkillEditor (create mode)", () => {
  it("disables the Create button until name is non-empty", async () => {
    render(wrap(<SkillEditor mode="create" />));
    const createButton = screen.getByRole("button", { name: /Create skill/i });
    expect(createButton).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText("secret-leakage-gate"), "secret-leakage-gate");
    expect(createButton).toBeDisabled();
    await userEvent.type(screen.getByRole("textbox", { name: "Body (markdown)" }), "body");
    expect(createButton).toBeEnabled();
  });

  it("submits + navigates to the new skill's edit route", async () => {
    render(wrap(<SkillEditor mode="create" />));
    await userEvent.type(screen.getByPlaceholderText("secret-leakage-gate"), "x");
    await userEvent.type(screen.getByRole("textbox", { name: "Body (markdown)" }), "body");
    await userEvent.click(screen.getByRole("button", { name: /Create skill/i }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "x", body: "body", type: "custom" })));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/skills/new-id"));
  });

  it("shows a 'save the skill first' hint instead of the Project context section (AC-37 create-mode gating)", () => {
    render(wrap(<SkillEditor mode="create" />));
    expect(screen.getByText(/save this skill first/i)).toBeInTheDocument();
    expect(screen.queryByText(/context-section-paths:/)).not.toBeInTheDocument();
  });
});

describe("SkillEditor (edit mode) — Project context to use", () => {
  const skill = {
    id: "skill-1",
    name: "secret-leakage-gate",
    description: "",
    type: "security" as const,
    source: "manual" as const,
    body: "body",
    enabled: true,
    version: 2,
    attached_context_paths: ["specs/2026-07-11-invariant.md"],
  };

  it("renders the section with the skill's own attached paths, and Save persists attached_context_paths + the active repo_id", async () => {
    hooksSpy.useSkill.mockReturnValue({ data: skill, isLoading: false, isError: false });
    render(wrap(<SkillEditor mode="edit" skillId="skill-1" />));

    expect(screen.getByText("context-section-repo:repo-1")).toBeInTheDocument();
    expect(screen.getByText("context-section-paths:specs/2026-07-11-invariant.md")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /attach docs\/new\.md/i }));
    await userEvent.click(screen.getByRole("button", { name: /save skill/i }));

    expect(hooksSpy.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "skill-1",
        patch: expect.objectContaining({
          attached_context_paths: ["specs/2026-07-11-invariant.md", "docs/new.md"],
        }),
        repo_id: "repo-1",
      }),
      expect.anything(),
    );
  });
});

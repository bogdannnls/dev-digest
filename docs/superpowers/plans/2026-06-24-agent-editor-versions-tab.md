# Agent Editor — Versions tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `Versions` tab to the Agent Editor that lists every immutable config snapshot from `agent_versions`, newest first, with an expandable per-row config view.

**Architecture:** Client-only. A new TanStack Query hook calls the existing `GET /agents/:id/versions` route, a new tab is wired into `AgentEditor.tsx` next to `Config` and `Skills`, and a `VersionsTab` component renders accordion rows over `AgentVersion[]`. Skill ids in each snapshot are resolved to names via the existing `useSkills()` hook; deleted skills fall back to their id with a muted `(deleted)` suffix. No server changes, no migration, no contract change.

**Tech Stack:** Next.js 15 (App Router) + React 19, TanStack Query, next-intl, `@devdigest/ui` primitives, `@devdigest/shared` contracts, vitest + jsdom + React Testing Library.

## Global Constraints

- Path aliases match the existing `client/` convention; no workspace, no root lockfile.
- All server access goes through `client/src/lib/api.ts` — no raw `fetch`.
- Server state owned by TanStack Query hooks in `client/src/lib/hooks/`; components don't fetch.
- Default to React Server Components; add `"use client"` only where needed (the new tab needs it — TanStack Query + state).
- Tab state lives in the `?tab=` query string in `client/src/app/agents/[id]/page.tsx`.
- Tests live next to the file under test (mirrors `SkillsTab.test.tsx`).
- i18n: all user-facing strings go in `client/messages/en/agents.json` under the `agents` namespace.
- Tab key / URL slug: `versions` (plural). Tab label: `Versions`.
- Tab order: `Config` → `Skills` → `Versions`.
- Tab icon: `History` (already exported from `@devdigest/ui`).
- Date format: locale-aware medium date + short time via `Intl.DateTimeFormat` (no relative time).
- No diff. No restore. No per-version author. No pagination. No server changes.

## Spec reference

Design lives at [docs/superpowers/specs/2026-06-24-agent-editor-versions-tab-design.md](../specs/2026-06-24-agent-editor-versions-tab-design.md).

## File map

- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/VersionsTab.tsx`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/VersionsTab.test.tsx`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/_components/VersionRow.tsx`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/styles.ts`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/index.ts`
- Modify: `client/src/lib/hooks/agents.ts` (add `useAgentVersions`; extend `useUpdateAgent.onSuccess` to invalidate the new key)
- Modify: `client/src/app/agents/[id]/_components/AgentEditor/constants.ts` (append tab entry)
- Modify: `client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.tsx` (render `VersionsTab`)
- Modify: `client/src/app/agents/[id]/page.tsx` (extend `VALID_TABS`)
- Modify: `client/messages/en/agents.json` (add `editor.tabs.versions` + `versions` block)

---

### Task 1: Add `useAgentVersions` hook + invalidate from `useUpdateAgent`

**Files:**
- Modify: `client/src/lib/hooks/agents.ts`
- Test (manual): exercised indirectly by Task 4 component tests; no separate hook test file (matches existing conventions in this file — no `*.test.ts` for `useAgentSkills` either).

**Interfaces:**
- Consumes: `api.get`, `useQuery`, `useQueryClient`, `useMutation` (already imported).
- Produces:
  - `useAgentVersions(agentId: string | null | undefined): UseQueryResult<AgentVersion[]>` with `queryKey: ["agent-versions", agentId]`, `enabled: !!agentId`.
  - `useUpdateAgent`'s `onSuccess` ALSO invalidates `["agent-versions", data.id]`.

- [ ] **Step 1: Add `AgentVersion` to the existing shared-types import**

In `client/src/lib/hooks/agents.ts`, replace the existing shared-types import line:

```ts
import type { Agent, AgentSkillLink, ModelInfo, PRFixtureMeta, Provider, ReviewStrategy, SkillsEvalResult } from "@devdigest/shared";
```

with:

```ts
import type { Agent, AgentSkillLink, AgentVersion, ModelInfo, PRFixtureMeta, Provider, ReviewStrategy, SkillsEvalResult } from "@devdigest/shared";
```

- [ ] **Step 2: Append `useAgentVersions` after `useAgent`**

Insert this block immediately after the existing `useAgent` function (just before `export interface CreateAgentInput`):

```ts
export function useAgentVersions(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ["agent-versions", agentId],
    queryFn: () => api.get<AgentVersion[]>(`/agents/${agentId}/versions`),
    enabled: !!agentId,
  });
}
```

- [ ] **Step 3: Extend `useUpdateAgent.onSuccess` to invalidate the new key**

Replace the existing `useUpdateAgent` body:

```ts
export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateAgentInput) => api.put<Agent>(`/agents/${id}`, patch),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.setQueryData(["agent", data.id], data);
    },
  });
}
```

with:

```ts
export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateAgentInput) => api.put<Agent>(`/agents/${id}`, patch),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.setQueryData(["agent", data.id], data);
      qc.invalidateQueries({ queryKey: ["agent-versions", data.id] });
    },
  });
}
```

- [ ] **Step 4: Typecheck**

Run from `client/`:

```
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/hooks/agents.ts
git commit -m 'Add useAgentVersions hook and invalidate it on agent update'
```

---

### Task 2: Wire the `versions` tab into the editor shell

**Files:**
- Modify: `client/src/app/agents/[id]/_components/AgentEditor/constants.ts`
- Modify: `client/src/app/agents/[id]/page.tsx`
- Modify: `client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.tsx`

**Interfaces:**
- Consumes: `EditorTab` type already exported from `constants.ts`; `VersionsTab` (placeholder will be added in Task 3).
- Produces: a third tab `{ key: "versions", labelKey: "editor.tabs.versions", icon: "History" }` rendered when `?tab=versions`.

At this point `VersionsTab` does not yet exist; this task adds a temporary inline stub so the editor compiles and the tab is reachable. Task 3 replaces the stub.

- [ ] **Step 1: Append the new tab to the editor `TABS` constant**

In `client/src/app/agents/[id]/_components/AgentEditor/constants.ts`, replace the `TABS` declaration:

```ts
/** Editor tabs. */
export const TABS: readonly EditorTab[] = [
  { key: "config", labelKey: "editor.tabs.config", icon: "Settings" },
  { key: "skills", labelKey: "editor.tabs.skills", icon: "Sparkles" },
];
```

with:

```ts
/** Editor tabs. */
export const TABS: readonly EditorTab[] = [
  { key: "config", labelKey: "editor.tabs.config", icon: "Settings" },
  { key: "skills", labelKey: "editor.tabs.skills", icon: "Sparkles" },
  { key: "versions", labelKey: "editor.tabs.versions", icon: "History" },
];
```

- [ ] **Step 2: Allow `?tab=versions` in the page**

In `client/src/app/agents/[id]/page.tsx`, replace:

```ts
const VALID_TABS = ["config", "skills"];
```

with:

```ts
const VALID_TABS = ["config", "skills", "versions"];
```

- [ ] **Step 3: Render the new tab body in `AgentEditor.tsx`**

In `client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.tsx`, replace the body:

```tsx
      <div style={s.body}>
        {tab === "config" && <ConfigTab agent={agent} />}
        {tab === "skills" && <SkillsTab agent={agent} />}
      </div>
```

with:

```tsx
      <div style={s.body}>
        {tab === "config" && <ConfigTab agent={agent} />}
        {tab === "skills" && <SkillsTab agent={agent} />}
        {tab === "versions" && <VersionsTab agent={agent} />}
      </div>
```

Add this import to the same file (after the `SkillsTab` import on line 11):

```ts
import { VersionsTab } from "./_components/VersionsTab";
```

- [ ] **Step 4: Add the i18n label so the tab renders**

In `client/messages/en/agents.json`, replace the `editor.tabs` block:

```json
"tabs": {
  "config": "Config",
  "skills": "Skills",
  "evals": "Evals",
  "stats": "Stats",
  "ci": "CI"
}
```

with:

```json
"tabs": {
  "config": "Config",
  "skills": "Skills",
  "versions": "Versions",
  "evals": "Evals",
  "stats": "Stats",
  "ci": "CI"
}
```

- [ ] **Step 5: Create a minimal compiling stub for `VersionsTab`**

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/VersionsTab.tsx`:

```tsx
"use client";

import React from "react";
import type { Agent } from "@devdigest/shared";

/** Versions tab — placeholder; populated in Task 3. */
export function VersionsTab(_props: { agent: Agent }) {
  return null;
}
```

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/index.ts`:

```ts
export { VersionsTab } from "./VersionsTab";
```

- [ ] **Step 6: Typecheck**

Run from `client/`:

```
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/app/agents/[id]/_components/AgentEditor/constants.ts \
        client/src/app/agents/[id]/page.tsx \
        client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.tsx \
        client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/VersionsTab.tsx \
        client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/index.ts \
        client/messages/en/agents.json
git commit -m 'Register Versions tab in Agent Editor (placeholder body)'
```

---

### Task 3: Build `VersionsTab` + `VersionRow` (real implementation)

**Files:**
- Modify: `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/VersionsTab.tsx`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/_components/VersionRow.tsx`
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/styles.ts`
- Modify: `client/messages/en/agents.json` (add `versions` block)

**Interfaces:**
- Consumes: `useAgentVersions` (Task 1), `useSkills` (existing in `lib/hooks/skills.ts`), `Agent` / `AgentVersion` / `Skill` from `@devdigest/shared`, `Badge` / `Skeleton` / `Icon` from `@devdigest/ui`.
- Produces: `VersionsTab({ agent: Agent })` default rendering for `tab === "versions"`. `VersionRow({ v, isCurrent, skillNameById })`.

- [ ] **Step 1: Add the i18n `versions` block**

In `client/messages/en/agents.json`, append the following top-level block (after the existing `config` block — sibling key):

```json
"versions": {
  "title": "Version history",
  "count": "{count, plural, one {# version} other {# versions}}",
  "current": "current",
  "onlyOne": "Only one version so far — this agent has not been edited yet.",
  "loadError": "Could not load version history.",
  "retry": "Retry",
  "fields": {
    "provider": "Provider",
    "model": "Model",
    "strategy": "Strategy",
    "ciFailOn": "CI gate",
    "repoIntel": "Repo intel",
    "skills": "Skills",
    "systemPrompt": "System prompt",
    "outputSchema": "Output schema"
  },
  "outputSchemaDefault": "default",
  "outputSchemaCustom": "custom",
  "noSkills": "(none)",
  "skillDeletedSuffix": "(deleted)",
  "repoIntelOn": "on",
  "repoIntelOff": "off"
}
```

- [ ] **Step 2: Create the styles file**

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/styles.ts`:

```ts
import type { CSSProperties } from "react";

/** Co-located styles for VersionsTab + VersionRow. */
export const s = {
  wrap: { maxWidth: 760 } satisfies CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 10, marginBottom: 16 } satisfies CSSProperties,
  title: { fontSize: 18, fontWeight: 700 } satisfies CSSProperties,
  loadError: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: 12,
    fontSize: 13,
    color: "var(--danger)",
    display: "flex",
    gap: 10,
    alignItems: "center",
  } satisfies CSSProperties,
  onlyOne: {
    border: "1px dashed var(--border)",
    borderRadius: 8,
    padding: 16,
    color: "var(--text-secondary)",
    fontSize: 13,
  } satisfies CSSProperties,
  list: { display: "flex", flexDirection: "column", gap: 8 } satisfies CSSProperties,
  row: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-surface)",
    overflow: "hidden",
  } satisfies CSSProperties,
  rowHeader: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    cursor: "pointer",
    background: "transparent",
    border: 0,
    width: "100%",
    textAlign: "left" as const,
    color: "inherit",
    font: "inherit",
  } satisfies CSSProperties,
  versionLabel: {
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    fontWeight: 600,
  } satisfies CSSProperties,
  timestamp: { fontSize: 13, color: "var(--text-secondary)" } satisfies CSSProperties,
  chevron: { marginLeft: "auto", color: "var(--text-secondary)" } satisfies CSSProperties,
  rowBody: {
    padding: "12px 14px 16px",
    borderTop: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } satisfies CSSProperties,
  defList: {
    display: "grid",
    gridTemplateColumns: "140px 1fr",
    rowGap: 6,
    columnGap: 12,
    fontSize: 13,
  } satisfies CSSProperties,
  defKey: { color: "var(--text-secondary)" } satisfies CSSProperties,
  defVal: { color: "var(--text-primary)" } satisfies CSSProperties,
  promptBlock: {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    whiteSpace: "pre-wrap" as const,
    background: "var(--bg-elev)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    padding: 10,
    maxHeight: 280,
    overflow: "auto",
  } satisfies CSSProperties,
  skillDeleted: { color: "var(--text-muted)", marginLeft: 4 } satisfies CSSProperties,
} as const;
```

- [ ] **Step 3: Implement `VersionRow`**

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/_components/VersionRow.tsx`:

```tsx
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon } from "@devdigest/ui";
import type { AgentVersion } from "@devdigest/shared";
import { s } from "../styles";

const FMT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function VersionRow({
  v,
  isCurrent,
  skillNameById,
}: {
  v: AgentVersion;
  isCurrent: boolean;
  skillNameById: Map<string, string>;
}) {
  const t = useTranslations("agents.versions");
  const [open, setOpen] = React.useState(false);

  const cfg = v.config;
  const hasCustomSchema = cfg.output_schema != null;
  const repoIntelLabel = cfg.repo_intel ? t("repoIntelOn") : t("repoIntelOff");
  const outputSchemaLabel = hasCustomSchema ? t("outputSchemaCustom") : t("outputSchemaDefault");

  return (
    <div style={s.row}>
      <button
        type="button"
        style={s.rowHeader}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={s.versionLabel}>v{v.version}</span>
        <span style={s.timestamp}>{FMT.format(new Date(v.created_at))}</span>
        {isCurrent && <Badge color="var(--accent)">{t("current")}</Badge>}
        <span style={s.chevron}>{open ? <Icon.ChevronDown size={16} /> : <Icon.ChevronRight size={16} />}</span>
      </button>
      {open && (
        <div style={s.rowBody}>
          <dl style={s.defList}>
            <dt style={s.defKey}>{t("fields.provider")}</dt>
            <dd style={s.defVal}>{cfg.provider}</dd>
            <dt style={s.defKey}>{t("fields.model")}</dt>
            <dd style={s.defVal}>{cfg.model}</dd>
            <dt style={s.defKey}>{t("fields.strategy")}</dt>
            <dd style={s.defVal}>{cfg.strategy}</dd>
            <dt style={s.defKey}>{t("fields.ciFailOn")}</dt>
            <dd style={s.defVal}>{cfg.ci_fail_on}</dd>
            <dt style={s.defKey}>{t("fields.repoIntel")}</dt>
            <dd style={s.defVal}>{repoIntelLabel}</dd>
            <dt style={s.defKey}>{t("fields.outputSchema")}</dt>
            <dd style={s.defVal}>{outputSchemaLabel}</dd>
            <dt style={s.defKey}>{t("fields.skills")}</dt>
            <dd style={s.defVal}>
              {cfg.skills.length === 0
                ? t("noSkills")
                : cfg.skills.map((id, i) => {
                    const name = skillNameById.get(id);
                    return (
                      <React.Fragment key={id}>
                        {i > 0 ? ", " : ""}
                        {name ? (
                          <span>{name}</span>
                        ) : (
                          <span>
                            <span>{id}</span>
                            <span style={s.skillDeleted}>{t("skillDeletedSuffix")}</span>
                          </span>
                        )}
                      </React.Fragment>
                    );
                  })}
            </dd>
          </dl>
          <div>
            <div style={{ ...s.defKey, fontSize: 13, marginBottom: 4 }}>{t("fields.systemPrompt")}</div>
            <pre style={s.promptBlock}>{cfg.system_prompt}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Replace the `VersionsTab` stub with the real component**

Overwrite `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/VersionsTab.tsx`:

```tsx
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Skeleton } from "@devdigest/ui";
import type { Agent } from "@devdigest/shared";
import { useAgentVersions } from "../../../../../../../lib/hooks/agents";
import { useSkills } from "../../../../../../../lib/hooks/skills";
import { VersionRow } from "./_components/VersionRow";
import { s } from "./styles";

/** Versions tab — read-only history of agent_versions snapshots, newest first. */
export function VersionsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("agents.versions");
  const versions = useAgentVersions(agent.id);
  const skills = useSkills();

  const skillNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const sk of skills.data ?? []) m.set(sk.id, sk.name);
    return m;
  }, [skills.data]);

  if (versions.isLoading) {
    return (
      <div style={s.wrap}>
        <div style={s.header}>
          <h2 style={s.title}>{t("title")}</h2>
        </div>
        <div style={s.list}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </div>
    );
  }

  if (versions.isError) {
    return (
      <div style={s.wrap}>
        <div style={s.header}>
          <h2 style={s.title}>{t("title")}</h2>
        </div>
        <div role="alert" style={s.loadError}>
          <span>{t("loadError")}</span>
          <button
            type="button"
            onClick={() => versions.refetch()}
            style={{ background: "transparent", border: 0, color: "var(--accent)", cursor: "pointer" }}
          >
            {t("retry")}
          </button>
        </div>
      </div>
    );
  }

  const data = versions.data ?? [];

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <h2 style={s.title}>{t("title")}</h2>
        <Badge color="var(--text-secondary)">{t("count", { count: data.length })}</Badge>
      </div>
      {data.length <= 1 ? (
        <div style={s.onlyOne}>{t("onlyOne")}</div>
      ) : (
        <div style={s.list}>
          {data.map((v) => (
            <VersionRow
              key={v.version}
              v={v}
              isCurrent={v.version === agent.version}
              skillNameById={skillNameById}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Typecheck**

Run from `client/`:

```
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 6: Smoke-render in browser (optional, manual)**

Run `pnpm dev` from `client/`, navigate to `/agents/<any-id>?tab=versions`. Expect: the new tab renders without runtime errors. (Tests in Task 4 cover behavior; the dev-server check is for paranoia only — skip if you trust the tests.)

- [ ] **Step 7: Commit**

```bash
git add client/messages/en/agents.json \
        client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/styles.ts \
        client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/VersionsTab.tsx \
        client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/_components/VersionRow.tsx
git commit -m 'Implement Agent Editor Versions tab (read-only history viewer)'
```

---

### Task 4: Tests for `VersionsTab`

**Files:**
- Create: `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/VersionsTab.test.tsx`

**Interfaces:**
- Consumes: `VersionsTab` (Task 3), `agents.json` messages, `QueryClient` seeding for `["agent-versions", id]` and `["skills"]`.
- Produces: vitest + RTL tests covering loading, error, single-version, multi-version + expansion + current badge + skill-name resolution + deleted-skill fallback.

- [ ] **Step 1: Write the failing test file**

Create `client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/VersionsTab.test.tsx`:

```tsx
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import agentsMessages from "../../../../../../../../messages/en/agents.json";
import { VersionsTab } from "./VersionsTab";
import type { Agent, AgentVersion, Skill } from "@devdigest/shared";

const agent: Agent = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Test Agent",
  description: "",
  provider: "openai",
  model: "gpt-4o-mini",
  system_prompt: "current prompt",
  output_schema: null,
  enabled: true,
  version: 2,
  strategy: "single-pass",
  ci_fail_on: "critical",
  repo_intel: true,
};

const skills: Skill[] = [
  { id: "s-a", name: "skill-a", description: "", type: "rubric", source: "manual", body: "", enabled: true, version: 1 },
  { id: "s-b", name: "skill-b", description: "", type: "security", source: "manual", body: "", enabled: true, version: 1 },
];

const v1: AgentVersion = {
  agent_id: agent.id,
  version: 1,
  created_at: "2026-06-20T12:00:00Z",
  config: {
    provider: "openai",
    model: "gpt-4o-mini",
    system_prompt: "older prompt",
    output_schema: null,
    strategy: "single-pass",
    ci_fail_on: "critical",
    repo_intel: false,
    skills: ["s-a", "s-deleted"],
  },
};

const v2: AgentVersion = {
  agent_id: agent.id,
  version: 2,
  created_at: "2026-06-23T15:30:00Z",
  config: {
    provider: "openai",
    model: "gpt-4o-mini",
    system_prompt: "current prompt",
    output_schema: null,
    strategy: "single-pass",
    ci_fail_on: "critical",
    repo_intel: true,
    skills: ["s-a", "s-b"],
  },
};

function buildClient(seeds: {
  versions?: AgentVersion[] | "loading" | "error";
  skills?: Skill[];
}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (seeds.versions && seeds.versions !== "loading" && seeds.versions !== "error") {
    qc.setQueryData(["agent-versions", agent.id], seeds.versions);
  }
  qc.setQueryData(["skills"], seeds.skills ?? skills);
  return qc;
}

function wrap(ui: React.ReactNode, qc: QueryClient) {
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

const apiSpy = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock("../../../../../../../lib/api", () => ({ api: apiSpy, ApiError: class extends Error {} }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VersionsTab", () => {
  it("renders both rows newest-first with the current badge on v2", () => {
    const qc = buildClient({ versions: [v2, v1] });
    render(wrap(<VersionsTab agent={agent} />, qc));

    expect(screen.getByText("Version history")).toBeInTheDocument();
    expect(screen.getByText("2 versions")).toBeInTheDocument();

    const headers = screen.getAllByRole("button", { expanded: false });
    expect(headers).toHaveLength(2);
    expect(headers[0]).toHaveTextContent("v2");
    expect(headers[1]).toHaveTextContent("v1");

    // current badge appears once, on the v2 row
    const currentBadges = screen.getAllByText("current");
    expect(currentBadges).toHaveLength(1);
    expect(headers[0]).toContainElement(currentBadges[0]);
  });

  it("expands a row to show config fields and the snapshot prompt", async () => {
    const user = userEvent.setup();
    const qc = buildClient({ versions: [v2, v1] });
    render(wrap(<VersionsTab agent={agent} />, qc));

    const v1Header = screen.getByRole("button", { name: /v1/ });
    await user.click(v1Header);

    expect(screen.getByText("Provider")).toBeInTheDocument();
    expect(screen.getByText("Model")).toBeInTheDocument();
    expect(screen.getByText("Repo intel")).toBeInTheDocument();
    expect(screen.getByText("off")).toBeInTheDocument();
    expect(screen.getByText("older prompt")).toBeInTheDocument();
  });

  it("resolves known skill ids to names and falls back to id with (deleted) for unknown ids", async () => {
    const user = userEvent.setup();
    const qc = buildClient({ versions: [v2, v1] });
    render(wrap(<VersionsTab agent={agent} />, qc));

    await user.click(screen.getByRole("button", { name: /v1/ }));

    // v1 has skills: ['s-a', 's-deleted']
    expect(screen.getByText("skill-a")).toBeInTheDocument();
    expect(screen.getByText("s-deleted")).toBeInTheDocument();
    expect(screen.getByText("(deleted)")).toBeInTheDocument();
  });

  it("shows the 'only one version' note when the agent has exactly one snapshot", () => {
    const onlyV1 = { ...v1, version: 1 };
    const qc = buildClient({ versions: [onlyV1] });
    render(wrap(<VersionsTab agent={{ ...agent, version: 1 }} />, qc));

    expect(screen.getByText(/Only one version so far/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /v1/ })).not.toBeInTheDocument();
  });

  it("renders the error state when the query fails", async () => {
    apiSpy.get.mockRejectedValueOnce(new Error("boom"));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["skills"], skills);
    render(wrap(<VersionsTab agent={agent} />, qc));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load version history.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the new test file and verify all five tests pass**

Run from `client/`:

```
pnpm exec vitest run src/app/agents/\[id\]/_components/AgentEditor/_components/VersionsTab/VersionsTab.test.tsx
```

Expected: 5 passed.

- [ ] **Step 3: Run the full client test suite to check for collateral damage**

Run from `client/`:

```
pnpm test
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/VersionsTab.test.tsx
git commit -m 'Test Agent Editor Versions tab'
```

---

### Task 5: Pre-merge architectural check

**Files:** none (review only).

- [ ] **Step 1: Run `/pr-self-review`**

Per the project `CLAUDE.md`: before marking work ready, if the diff touches `client/` or `server/`, run `/pr-self-review`. This diff is `client/`-only.

Expected: MUST findings = 0 (or a documented justification + fix). SHOULD findings are advisory.

- [ ] **Step 2: Address any MUST findings**

If any MUST finding lands, propose a fix and ask before applying.

- [ ] **Step 3: Final typecheck + tests once more**

Run from `client/`:

```
pnpm typecheck && pnpm test
```

Expected: typecheck clean, tests green.

- [ ] **Step 4: No commit needed unless review changes were applied**

If review fixes were applied, commit them with a descriptive message:

```bash
git commit -am 'Address pr-self-review findings on Versions tab'
```

---

## Self-Review

**Spec coverage check** (against [the design doc](../specs/2026-06-24-agent-editor-versions-tab-design.md)):

| Spec item | Task |
|---|---|
| `useAgentVersions` hook + invalidation on update | Task 1 |
| Tab registration in `constants.ts`, `VALID_TABS`, `AgentEditor.tsx` | Task 2 |
| i18n `editor.tabs.versions` | Task 2 |
| i18n `versions.*` block | Task 3 |
| Header with title + count badge | Task 3 (`VersionsTab`) |
| Skeleton loading, inline error w/ retry, "only one version" empty | Task 3 (`VersionsTab`) |
| Accordion rows, `current` badge on matching `agent.version` | Task 3 (`VersionRow`) |
| Per-row definition list + collapsible prompt block | Task 3 (`VersionRow`) |
| Skill name resolution via `useSkills()`, `(deleted)` fallback | Task 3 (`VersionsTab` + `VersionRow`) |
| `Intl.DateTimeFormat` medium date + short time | Task 3 (`VersionRow`) |
| Tests covering ordering, current badge, expansion, skill resolution, single-version, error | Task 4 |
| No backend changes | (all client) |
| Pre-merge architectural check | Task 5 |

**Placeholder scan:** none — every step has concrete code or commands.

**Type consistency:**
- `useAgentVersions` queryKey `["agent-versions", agentId]` matches the invalidation in `useUpdateAgent.onSuccess` and the test seeding.
- `VersionRow` prop names (`v`, `isCurrent`, `skillNameById`) match the call site in `VersionsTab`.
- `VersionsTab({ agent: Agent })` signature matches the `AgentEditor.tsx` call site.
- Tab key string is `"versions"` everywhere (constants, `VALID_TABS`, `AgentEditor.tsx`, page URL, i18n key).
- All i18n keys used in `VersionRow` (`agents.versions.fields.*`, `current`, `repoIntelOn/Off`, `outputSchema*`, `skillDeletedSuffix`, `noSkills`) are present in the messages block added in Task 3 Step 1.
- All i18n keys used in `VersionsTab` (`agents.versions.title`, `count`, `onlyOne`, `loadError`, `retry`) are present in the same block.

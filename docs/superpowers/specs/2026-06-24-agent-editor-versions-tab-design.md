# Agent Editor — Versions tab — design

Date: 2026-06-24
Status: design approved by user; pending spec review before writing-plans.
Depends on: nothing new — the server-side versioning shipped earlier.

## Context

Every config edit on an agent already snapshots the new config into
[`agent_versions`](../../../server/src/db/schema/agents.ts:38) and bumps
`agents.version`. The repository exposes the history through two routes
([server/src/modules/agents/routes.ts:149](../../../server/src/modules/agents/routes.ts:149)):

- `GET /agents/:id/versions` → `AgentVersion[]`, newest first.
- `GET /agents/:id/versions/:version` → one `AgentVersion`.

The contract is already in
[`@devdigest/shared`](../../../server/src/vendor/shared/contracts/knowledge.ts:230):

```ts
AgentVersion = {
  agent_id: string;
  version: number;
  config: AgentVersionConfig; // provider, model, system_prompt, output_schema,
                              // strategy, ci_fail_on, repo_intel, skills: string[]
  created_at: string;
};
```

The client side does **not** surface this anywhere. The only visible signal of
versioning today is the `"Saved (v3)"` toast in `ConfigTab`
([ConfigTab.tsx:74](../../../client/src/app/agents/[id]/_components/AgentEditor/_components/ConfigTab/ConfigTab.tsx)).
The `AgentEditor.tsx` file comment already anticipates the gap: *"Later lessons
add Skills/Evals/Stats/CI tabs; the Part-0 starter ships Config only."*

This spec adds a third Agent Editor tab — `Versions` — that lists those
snapshots and lets a user inspect any past config. **Read-only.** No diff
picker, no restore.

## Goals

- A user opens any agent and sees its full edit history, newest first.
- Each row shows version number and timestamp; the row whose `version` matches
  the agent's current `version` is marked `current`.
- Expanding a row reveals the snapshot config — provider, model, strategy, CI
  gate, repo-intel flag, linked skills (resolved to names), and the
  system prompt.
- Wire conventions hold: server access through `lib/api.ts`, query through
  `lib/hooks/`, tab state in `?tab=`, i18n via `next-intl`, tests next to file.

## Non-goals

- **Diff between versions.** Out of scope. A separate spec can add a two-version
  picker and a prompt diff renderer.
- **Restore to a version.** Out of scope. Would require a new
  `POST /agents/:id/versions/:version/restore` endpoint — additive when added.
- **Per-version author.** `agent_versions` does not store `created_by`. The
  user explicitly chose to skip the schema migration that would add it.
- **Pagination.** Per-agent version cardinality is low in practice. Plain
  scroll is acceptable for v1.
- **Server changes of any kind.** This spec is client-only.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Tab key / URL slug | `versions` (plural) | Matches the API path `/agents/:id/versions` and reads naturally for a list. The user-facing label is `Versions`. |
| 2 | Tab order | `Config` → `Skills` → `Versions` | Versions is a read-only inspection surface; config-editing tabs come first. |
| 3 | Tab icon | `History` (Lucide) | Already in the `IconName` union used by `editor.tabs`. Conveys "past states" without overloading "clock". |
| 4 | Newest-first ordering | Yes — rely on the server's `desc(version)` order | Matches the user's mental model and the repository's existing query. No client-side sort. |
| 5 | Current-version marker | Inline `current` badge on the row where `version === agent.version` | A single badge is enough; no need for separate styling on the whole row. |
| 6 | Expansion model | Per-row accordion. Multiple rows can be open at once. | Lets the user keep two snapshots open as a poor-man's diff while still leaving "real diff" to a future spec. |
| 7 | Skill name resolution | Use the existing `useSkills()` hook to build an id→name map. Render the snapshot's `skills: string[]` as a comma-separated list of names. A skill that no longer exists falls back to its id with a muted `(deleted)` suffix. | One extra cached query; the hook is already used elsewhere on the page. Showing ids alone would be hostile to the reader. |
| 8 | System prompt rendering | Collapsible mono block (`<details>` or the existing `Textarea` in read-only mode) inside the expanded row | The prompt can be long. Don't push other fields off-screen by default. |
| 9 | Output schema rendering | Show literal "default" / "custom" based on whether `output_schema` is null. No JSON tree. | The Config tab already treats output schema as a fixed "default" select — full snapshot rendering is overkill here. |
| 10 | Empty / loading / error states | Reuse `Skeleton` rows for loading, the same `ErrorState` pattern as the parent page for error, an "Only one version so far" inline note for an agent that has never been edited | Consistent with the rest of the editor. |
| 11 | Date format | `Intl.DateTimeFormat` with a locale-aware medium date + short time (e.g. `Mar 14, 2026 · 4:32 PM`). No relative time. | Versions are an audit surface — exact timestamps matter more than "3 days ago". |
| 12 | Cache key | `["agent-versions", agentId]`, invalidated automatically when `useUpdateAgent` succeeds | Reuses TanStack Query; mirrors the `["agent", id]` pattern. |

## Architecture

All changes live in `client/`.

### 1. Hook — `client/src/lib/hooks/agents.ts`

Add one query hook:

```ts
export function useAgentVersions(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ["agent-versions", agentId],
    queryFn: () => api.get<AgentVersion[]>(`/agents/${agentId}/versions`),
    enabled: !!agentId,
  });
}
```

Extend `useUpdateAgent`'s `onSuccess` to also invalidate
`["agent-versions", id]` so a successful save refreshes the list without
forcing a remount.

### 2. Tab registration

- `client/src/app/agents/[id]/_components/AgentEditor/constants.ts`
  Append `{ key: "versions", labelKey: "editor.tabs.versions", icon: "History" }`.

- `client/src/app/agents/[id]/page.tsx`
  Add `"versions"` to `VALID_TABS`.

- `client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.tsx`
  Import and render `<VersionsTab agent={agent} />` when `tab === "versions"`.

### 3. i18n — `client/messages/en/agents.json`

Add under `editor.tabs`:

```json
"versions": "Versions"
```

Add a new top-level block:

```json
"versions": {
  "title": "Version history",
  "count": "{count, plural, one {# version} other {# versions}}",
  "current": "current",
  "onlyOne": "Only one version so far — this agent has not been edited yet.",
  "loadError": "Could not load version history.",
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

### 4. Component — `VersionsTab/`

New folder under
`client/src/app/agents/[id]/_components/AgentEditor/_components/VersionsTab/`,
mirroring the `SkillsTab/` layout:

```
VersionsTab/
  VersionsTab.tsx
  VersionsTab.test.tsx
  _components/
    VersionRow.tsx        // accordion row (collapsed header + expanded body)
  styles.ts
  index.ts
```

**`VersionsTab.tsx`** responsibilities:

- Call `useAgentVersions(agent.id)` and `useSkills()`.
- Render header (title + count badge).
- Render `Skeleton` rows while loading.
- Render an inline error (NOT a full-screen `ErrorState`) on failure with a
  retry link — the rest of the editor still works.
- Render the "Only one version so far" empty-ish state when `data.length === 1`.
- Otherwise, render a `VersionRow` per snapshot.

**`VersionRow.tsx`** responsibilities:

- Collapsed header: `v{N}` (mono), formatted timestamp, `current` badge when
  `version === agent.version`, chevron.
- Local `open` state. Multiple rows may be open independently.
- Expanded body: a small two-column definition list of the simple fields
  (provider/model/strategy/CI gate/repo intel/output schema/skills) + a
  collapsible mono block for `system_prompt`.
- Accepts a pre-computed `skillNameById: Map<string, string>` prop from
  `VersionsTab` so the row stays presentational.

### 5. No backend changes

Confirmed: no migration, no new route, no new contract, no `lib/api.ts` change
beyond the path used by the new hook (which goes through the existing
`api.get`).

## Tests

- `VersionsTab.test.tsx` (vitest + RTL, jsdom):
  - Renders rows from a mocked `useAgentVersions` and `useSkills`, newest first.
  - The row whose `version` matches `agent.version` shows the `current` badge.
  - Clicking a row reveals the config fields and the system prompt.
  - Skill ids that exist resolve to names; an unknown id renders the id with
    the `(deleted)` suffix.
  - Loading state shows skeletons; error state shows the inline error.
  - Single-version state shows the "only one version" note.

No server-side tests change.

## Rollout

Single-PR change, client-only. Safe to ship in isolation — does not touch any
shared contract.

## Risks / trade-offs

- **Skill rename is not historical.** Snapshots store ids; we resolve them to
  *current* names. A renamed skill will appear with its new name in older
  rows. Acceptable for v1 and consistent with how every other surface treats
  skills today.
- **Deleted skills show `(deleted)`.** Already a known limitation of the
  snapshot model. Better than silently dropping them.
- **Long version lists scroll forever.** Will become a real problem only for
  agents edited hundreds of times. Pagination is YAGNI until we see it.
- **The empty-after-first-edit state is not empty.** Every agent has at least
  v1 from creation, so "only one version" is the real empty state, not "no
  rows". The copy reflects that.

## Open questions

None blocking. The diff/restore extensions are explicitly deferred to a future
spec.

## Out-of-scope follow-ups (one paragraph each)

- **Diff view**: two-version picker at the top of the tab; render a
  side-by-side diff of `system_prompt` (using the existing diff component the
  PR review surface uses) and a simple table diff of scalar fields. Skill
  list diff is a set-with-order diff.
- **Restore**: `POST /agents/:id/versions/:version/restore` re-applies a
  snapshot's config via the existing update path (which bumps to a new
  version). A "Restore this version" button on each row with a confirmation
  modal.
- **Per-version author**: an additive migration that adds `created_by uuid`
  to `agent_versions`, populates it on insert from the request context, and
  surfaces a user name on each row.

# Skills UI — Spec B: Agent Editor Skills tab — design

Date: 2026-06-23
Status: design approved; pending spec review before writing-plans.
Depends on: [Spec A](2026-06-23-skills-ui-list-editor-design.md) (ships the skills inventory + CRUD).

## Context

Spec A landed the standalone Skills inventory at `/skills`. The next surface is the **Agent Editor → Skills tab** that lets a user wire up which skills an agent's prompt includes, in what order, and which are currently active.

The server already exposes the link routes:

- `GET /agents/:id/skills` — returns linked skills with their order (see [server/src/modules/agents/routes.ts:145](../../../server/src/modules/agents/routes.ts:145)).
- `POST /agents/:id/skills` — accepts either `{ skill_ids: string[] }` (set/reorder the whole ordered set) or `{ skill_id, order? }` (link one).

The `agent_skills` table has columns `agent_id, skill_id, order` — **no per-agent enabled flag**. This spec adds one.

The client side has only a placeholder: [AgentEditor.tsx](../../../client/src/app/agents/[id]/_components/AgentEditor/AgentEditor.tsx) renders just the `Config` tab; the file comment says "Later lessons add Skills/Evals/Stats/CI tabs". This spec adds the Skills tab.

## Goals

- A user can browse all skills in their workspace from inside an agent editor, link/unlink them with one click, reorder them by drag, and toggle individual linked skills on/off without unlinking.
- "Order matters — earlier skills appear earlier in the assembled prompt" surfaces in the UI as inline hint copy.
- The data shape supports the downstream prompt-assembly step (a separate spec): given an agent, return the ordered list of `(skill_id, enabled)` pairs.
- Existing conventions hold: Drizzle migration is append-only; routes carry Zod schemas; server access funnels through `lib/api.ts`; tests follow `*.it.test.ts` for integration.

## Non-goals

- Prompt-assembly consumption of the new `enabled` field — lives in a separate spec for `reviewer-core`.
- A skill-picker that creates new skills from inside the agent editor (use `/skills/new` for that — already shipped in Spec A).
- A diff-style "what changed since v1" indicator for the agent's skill list. The agent's `agent_versions` snapshot already records `skills: string[]`; a later spec can extend it to include the per-skill enabled flag if useful.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Where does per-agent enable/disable live? | New column `enabled boolean NOT NULL DEFAULT true` on `agent_skills` | The design HTML shows a checkbox per row inside the agent editor — that's per-agent, not the skill's global enabled flag. Keeping it on the join row is the minimal correct model. |
| 2 | Drag-to-reorder library | `@dnd-kit/core` + `@dnd-kit/sortable` (new client deps) | Accessibility-first (keyboard reorder works out of the box), no `react-dnd` provider boilerplate, ~30KB gzipped total. The design's "Order matters — drag to reorder" hint expects native-feeling reorder. |
| 3 | Reorder UX | Drag handle on the left of each row; the whole row is the drag target; live preview while dragging | Matches the design HTML's `≡`-style handle. |
| 4 | Unlinking a skill | Kebab menu → "Remove from agent" | The checkbox is dedicated to enable/disable. Two concepts → two affordances. |
| 5 | "Add skill" from inside the tab | An "+ Add skill" button at the top of the linked list opens a side picker showing all workspace skills not yet linked to this agent. Picker has a search input + type filter chips (same primitives as Spec A's list-page toolbar). Click a row → links + closes picker. | Avoids forcing users to leave the agent editor to discover skills. |
| 6 | Versioning on link/order/enable changes | These changes DO NOT bump the agent's `version` | Same convention as `agent_skills` today — link-set changes are not in `isConfigChange`. The agent's `agent_versions` snapshot still records the linked skill ids per its existing rule. |
| 7 | Validation: can an agent have zero linked skills? | Yes — agents work without skills (system prompt only). The empty state shows "No skills linked yet" with a primary "Add skill" CTA. | Matches Spec A's empty-state pattern. |
| 8 | Optimistic updates | Toggling enabled and drag-reorder are optimistic; the picker's link operation is also optimistic. | TanStack Query `onMutate` mirrors the Spec A toggle pattern. Rollback on error via a toast. |

## Architecture

### Server (extend the existing `agents` module)

**Migration**:

```
server/src/db/migrations/0010_agent_skills_enabled.sql
```

```sql
ALTER TABLE agent_skills
  ADD COLUMN enabled boolean NOT NULL DEFAULT true;
```

Append-only, backward-compatible default. Existing rows become enabled.

**Schema update** ([server/src/db/schema/agents.ts](../../../server/src/db/schema/agents.ts)):

```ts
export const agentSkills = pgTable(
  'agent_skills',
  {
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id').notNull().references(() => skills.id, { onDelete: 'cascade' }),
    order: integer('order').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => ({ pk: primaryKey({ columns: [t.agentId, t.skillId] }) }),
);
```

**Repository** ([server/src/modules/agents/repository.ts](../../../server/src/modules/agents/repository.ts)):

- Extend `LinkedSkillRow` to include `enabled: boolean`.
- `linkedSkills(agentId)` already joins `agent_skills` ⇄ `skills`; just project `enabled` through.
- `linkSkill(agentId, skillId, order, enabled = true)` — accept an optional `enabled` arg (default true).
- New `setSkillEnabled(agentId, skillId, enabled): Promise<boolean>` — single-row UPDATE.
- `setSkills(agentId, skillIds: string[])` — preserve `enabled` of pre-existing rows when re-linking. Implementation: read existing `(skillId → enabled)` map, then `DELETE` + `INSERT` with the order pulled from the new list and `enabled` from the map (default true for net-new rows). One transaction.

**Service** ([server/src/modules/agents/service.ts](../../../server/src/modules/agents/service.ts)):

- Extend `AgentSkillLink` contract to include `enabled: boolean` (changes the shared contract — see below).
- `setSkillEnabled(workspaceId, agentId, skillId, enabled)` returns the updated link list or `undefined` if the agent/link is missing.
- `linkSkill(workspaceId, agentId, skillId, order?, enabled?)` already exists; thread `enabled`.

**Routes** ([server/src/modules/agents/routes.ts](../../../server/src/modules/agents/routes.ts)):

- Extend `POST /agents/:id/skills`'s `SetSkillsBody`:
  - `skill_ids: string[]` (existing) — set/reorder, preserves enabled per the repo rule above.
  - `skill_id: string` (existing) + `order?: number` (existing) + `enabled?: boolean` (new) — link one with explicit enabled.
- New `PATCH /agents/:id/skills/:skillId` body `{ enabled: boolean }` — toggle a single link's enabled. Returns 200 with the updated link list, 404 if agent or link missing.

**Shared contract** ([server/src/vendor/shared/contracts/knowledge.ts:1019-1024](../../../server/src/vendor/shared/contracts/knowledge.ts:1019)):

Extend `AgentSkillLink`:

```ts
export const AgentSkillLink = z.object({
  agent_id: z.string(),
  skill_id: z.string(),
  order: z.number().int(),
  enabled: z.boolean(),
});
```

This is a breaking change to the contract shape. Audit consumers — only the agent module's routes use this currently. Update both the server and client mirrors.

### Client

**New dependencies**:

```json
{
  "dependencies": {
    "@dnd-kit/core": "^6.x",
    "@dnd-kit/sortable": "^7.x",
    "@dnd-kit/utilities": "^3.x"
  }
}
```

(Add to `client/package.json` only — server doesn't need them.)

**New hooks** ([client/src/lib/hooks/agents.ts](../../../client/src/lib/hooks/agents.ts)):

```ts
useAgentSkills(agentId)              // GET /agents/:id/skills → AgentSkillLink[]
useSetAgentSkills(agentId)           // POST /agents/:id/skills with { skill_ids }
useLinkAgentSkill(agentId)           // POST /agents/:id/skills with { skill_id }
useUnlinkAgentSkill(agentId)         // DELETE /agents/:id/skills/:skillId (new route, see below)
useSetAgentSkillEnabled(agentId)     // PATCH /agents/:id/skills/:skillId with { enabled }
```

The new `DELETE /agents/:id/skills/:skillId` route is added in routes.ts (the existing API only supports unlinking by setting the whole `skill_ids` set without it — too coarse for a single-row unlink). Trivial repo method `unlinkSkill` already exists.

All four mutations use optimistic `onMutate` patterns mirrored from Spec A's `useUpdateSkill`.

**Agent Editor wiring** ([client/src/app/agents/[id]/_components/AgentEditor/](../../../client/src/app/agents/[id]/_components/AgentEditor/)):

- `constants.ts` — extend `TABS` to include `{ key: "skills", labelKey: "editor.tabs.skills", icon: "Sparkles" }` between `config` and the deferred `evals`. Keep `VALID_TABS` in sync at [client/src/app/agents/[id]/page.tsx](../../../client/src/app/agents/[id]/page.tsx).
- `AgentEditor.tsx` — render `<SkillsTab agent={agent} />` when `tab === "skills"`.

**New components**:

```
client/src/app/agents/[id]/_components/AgentEditor/_components/SkillsTab/
  SkillsTab.tsx                                     # owns the linked-skills list
  SkillsTab.test.tsx
  styles.ts
  constants.ts                                      # column widths, max-height
  index.ts
  _components/
    LinkedSkillRow/                                 # one row in the linked list
      LinkedSkillRow.tsx                            # drag handle, checkbox, name, type badge, kebab
      LinkedSkillRow.test.tsx
      styles.ts
      index.ts
    AddSkillPicker/                                 # the side picker for unlinked skills
      AddSkillPicker.tsx                            # search + type filter + row click → link
      AddSkillPicker.test.tsx
      styles.ts
      index.ts
```

**`SkillsTab` data flow**:

```
SkillsTab
  → useAgentSkills(agent.id) → linked: AgentSkillLink[]
  → useSkills() → all workspace skills (cached, shared with /skills page)
  → derive `linkedById` map for fast lookup; derive `unlinked = all.filter(s => !linkedById.has(s.id))` for the picker
  → DndContext + SortableContext wrap the linked rows
  → reorder fires useSetAgentSkills(agent.id).mutate({ skill_ids: newOrder })
  → checkbox toggle fires useSetAgentSkillEnabled(agent.id).mutate({ skillId, enabled })
  → kebab → Remove → useUnlinkAgentSkill(agent.id).mutate(skillId)
  → AddSkillPicker.onPick fires useLinkAgentSkill(agent.id).mutate({ skill_id })
```

The "X of Y enabled" pill computes from the linked array.

### i18n

Extend `client/messages/en/agents.json` under the existing `skills` namespace (some keys already exist — `title`, `enabledCount`, `filterPlaceholder`, `orderHint`):

```json
{
  "skills": {
    "title": "Skills",
    "enabledCount": "{enabled} of {total} enabled",
    "filterPlaceholder": "Filter skills…",
    "orderHint": "Order matters — earlier skills appear earlier in the assembled prompt. Drag to reorder.",
    "addSkill": "Add skill",
    "removeFromAgent": "Remove from agent",
    "emptyTitle": "No skills linked yet",
    "emptyBody": "Skills are reusable directives appended to this agent's system prompt. Add one to start.",
    "picker": {
      "title": "Add a skill",
      "subtitle": "Workspace skills not yet linked to this agent.",
      "searchPlaceholder": "Search skills…",
      "noUnlinked": "All workspace skills are already linked.",
      "createSkill": "Create a new skill"
    }
  }
}
```

Also add `editor.tabs.skills` (already in the file from the explore — verify).

## Components & data flow

### `SkillsTab`

Header row: title + "{enabled} of {total} enabled" pill + filter input + `Add skill` button. Order hint as a one-line caption. Then the sortable list.

Each `LinkedSkillRow`:

- Drag handle (`≡` icon) — initiates drag via `useSortable`.
- Checkbox bound to `link.enabled` — `onChange` fires `setSkillEnabled` mutate, optimistic.
- Skill name (mono) + type badge (reuse `TYPE_BADGE_BG` from Spec A's `SkillsListView/constants.ts` — promote to a shared client util OR duplicate locally; **decision: duplicate locally** to avoid a cross-page import (the `ui-architecture` rule).
- Kebab → "Remove from agent" calls `unlinkAgentSkill.mutate(link.skill_id)`.

`AddSkillPicker` renders as a side drawer (same width and pattern as Spec A's `SkillPreviewDrawer` — but again, **duplicate the styles**, do not import from `app/skills`). Lists `unlinked` skills, each row is a button that on click links + closes the drawer.

### Error handling

- All mutations surface failures through the existing global error toast.
- Optimistic update rollback on error.
- 404 from the server (e.g. agent deleted in another tab) → close the drawer and refetch the agent list.

### Edge cases

- **Reordering with concurrent edits**: last-write-wins. The `POST /agents/:id/skills` route replaces the whole order set. If two tabs disagree on the order, the last save wins. v1 accepts this.
- **Disabled-only state**: an agent with all skills disabled is allowed. Downstream prompt assembly (separate spec) just gets an empty enabled list.
- **Picker showing 0 unlinked skills**: empty state with "All workspace skills are already linked" + secondary CTA to create a new skill (links to `/skills/new`).
- **Removing the last skill** drops to the "No skills linked yet" empty state.

## Test plan

Server (vitest):

| File | Cases |
|---|---|
| `server/test/agent-skills-enabled.it.test.ts` (new) | Migration applies and existing rows default to `enabled = true` · `linkSkill(agentId, skillId, order, enabled)` inserts with the right enabled · `setSkillEnabled` flips the flag · `setSkills` preserves enabled of pre-existing rows but defaults new rows to true · `linkedSkills` returns the new field · `PATCH /agents/:id/skills/:skillId` returns 200 on success, 404 on missing agent/link/cross-workspace · `DELETE /agents/:id/skills/:skillId` returns 200 + updated link list, 404 on missing |

Client (vitest + jsdom + RTL):

| File | Cases |
|---|---|
| `SkillsTab.test.tsx` | empty state when no links · renders rows in `order` ascending · checkbox toggles via `useSetAgentSkillEnabled` (optimistic flip asserted) · kebab → Remove calls `useUnlinkAgentSkill` · drag-reorder fires `useSetAgentSkills` with reordered `skill_ids` (mocking the dnd events via `userEvent.keyboard` for accessibility-driven reorder) · filter input narrows visible rows by name |
| `LinkedSkillRow.test.tsx` | renders name + type badge · checkbox `aria-checked` reflects enabled · disabled rendering dims the row |
| `AddSkillPicker.test.tsx` | shows only unlinked skills · search filters · clicking a row fires `useLinkAgentSkill` and closes · "All workspace skills are already linked" empty state |

The shared contract change (`AgentSkillLink` gains `enabled`) is exercised by every consumer test indirectly.

## Acceptance criteria

- A user opens the agent editor and the Skills tab is visible (not just Config).
- An agent with no linked skills shows the empty state with a clear `Add skill` CTA.
- The picker shows only workspace skills not already linked to this agent.
- Clicking a picker row links the skill (optimistic), the drawer closes, the new row appears at the bottom of the list with `enabled = true`.
- Dragging a row to a new position persists the order; reloading the page preserves the new order.
- The inline checkbox toggles `enabled` without unlinking.
- The kebab → Remove unlinks the skill (row disappears from the list, appears in the picker again).
- The "{enabled} of {total} enabled" pill updates live.
- Cross-workspace agent ids return 404 from every endpoint.
- The agent's `version` does NOT bump when skill links change.

## Open questions

None at design time. Cross-tab concurrent-edit conflicts are an explicit deferral.

## References

- Spec A (skills inventory): [docs/superpowers/specs/2026-06-23-skills-ui-list-editor-design.md](2026-06-23-skills-ui-list-editor-design.md)
- Existing link routes: [server/src/modules/agents/routes.ts:145-170](../../../server/src/modules/agents/routes.ts:145)
- Design reference frame: "Agent Editor · Skills" in [docs/DevDigest Design (standalone).html](../../DevDigest%20Design%20%28standalone%29.html)

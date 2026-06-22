# Skills UI — list page + editor (Spec A) — design

Date: 2026-06-23
Status: design approved; pending spec review before writing-plans.

## Context

The `skills` table already exists in `server/src/db/schema/skills.ts` (workspace-scoped rows with `name`, `description`, `type`, `body`, `enabled`, `version`, plus a `skill_versions` history table). The agents module already exposes the agent ↔ skill **link** routes (`GET/POST /agents/:id/skills`), and the agent editor reserves a Skills tab slot (currently only the `Config` tab is implemented).

What is missing — and what this spec covers:

1. **Server-side skills CRUD** (the link routes assume skills already exist, but nothing creates them).
2. **Client-side standalone Skills page** at `/skills` — list of skill cards with a side-preview drawer.
3. **Client-side skill editor** at `/skills/[id]` and `/skills/new` — name / description / type / markdown body with a live-preview pane.

Out of this spec, deliberately:

- The Agent Editor → Skills tab (linking, reorder, enable/disable per agent) — **Spec B**.
- Skills import (markdown / archive with safe extraction) — **Spec C**.
- A new `Test Quality Reviewer` agent + with-vs-without-skills control experiment — **Spec D**.
- Prompt-assembly consumption of skills inside `reviewer-core` — separate spec.
- Skill version history viewer / revert — deferred (the history rows are still written; just no UI yet).
- Optimistic concurrency on PATCH (`If-Match` / `expected_version`) — deferred.
- Unique-name constraint on `(workspace_id, name)` — not added; uniqueness is a UX nicety, not a data-integrity requirement.

## Goals

- A user can create, view, edit, toggle enabled, and delete skills in their workspace from the UI.
- The list page reads as the canonical "skills inventory" with quick filtering, an at-a-glance type signal, and an inline enabled toggle.
- The editor is editable without being heavy: markdown body with a live preview pane, no rich-text widget, no syntax highlighter.
- Existing conventions are preserved: every server call goes through `lib/api.ts`; server state lives in TanStack Query hooks; Zod validates at the route boundary; errors extend `platform/errors.ts`; tests follow the `*.it.test.ts` integration suffix.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Scope of this spec | Skills CRUD + list page + editor only | Originally proposed bundling everything (import, agent linking, new agent, control experiment) into one document; pushed back and decomposed into four specs (A–D) so each lands reviewably. |
| 2 | Editor location | Dedicated route `/skills/[id]` and `/skills/new` | Mirrors the agent editor (`/agents/[id]`); deep-linkable; keeps the read-only preview drawer clearly separated from edit. |
| 3 | Markdown body editor | Plain `<Textarea mono />` on the left + `react-markdown` preview on the right | User picked split-with-preview over plain textarea. `react-markdown` is already vendored for the PR Brief and Compose Review surfaces. |
| 4 | List-card click behaviour | Open a right-side drawer (~480px) with read-only preview + "Edit" button + kebab → Delete | Matches the "click → preview" pattern requested. Editing is one click away on a dedicated route. |
| 5 | "Add" button affordance | Button with dropdown caret now — "Create" enabled, "Import" disabled with "Coming soon" tooltip | Final shape of the affordance ships immediately; the dead menu item is acceptable cost until Spec C lands and removes the tooltip. |
| 6 | Versioning behaviour | Bump `version` and insert into `skill_versions` on every update; show `Saved (vN)` inline. No history viewer yet. | Matches the agent editor pattern (`useUpdateAgent` returns `{ version }`). The history rows are written so future history UI has data to render. |
| 7 | Delete behaviour | Hard delete with cascade + confirm dialog showing "Used by N agents" | The schema already cascades `skill_versions` (skills.ts:23) and `agent_skills` (agents.ts:59). A confirm dialog with usage count is enough friction. |
| 8 | List toolbar | Search-by-name (debounced, client-side) + multi-select type filter chips + Add button | Skill counts are small (single digits in dev, dozens at scale); client-side filtering is cheap and avoids server-side query plumbing. |
| 9 | Unique skill name | Not enforced; no UI warning either | Users may want forked variants of the same skill. v1 is silent on collisions; revisit if it bites in practice. |
| 10 | Workspace isolation violation response | `404`, not `403` | Matches the agents module convention; leaks less existence information. |

## Architecture

### Server module (new): `server/src/modules/skills/`

Mirrors the structure of `server/src/modules/agents/`:

```
modules/skills/
  repository.ts   # workspace-scoped Drizzle queries
  service.ts      # workspace-scoped facade; owns the version-bump transaction
  routes.ts       # Fastify routes with Zod schemas at the boundary
  constants.ts    # re-export SkillType / SkillSource from the shared contract
```

Server tests live flat under `server/test/` per the existing convention (e.g. `agents-versions.it.test.ts`, `routes-smoke.test.ts`), with `*.it.test.ts` for integration and `*.test.ts` for unit. New files:

```
server/test/skills.it.test.ts          # repository + routes integration (real Postgres)
server/test/skills-routes.test.ts      # Zod validation + status codes, mocked service
```

The transaction for `update` is the one place that matters — version bump + history insert must be atomic:

```ts
return db.transaction(async (tx) => {
  const next = await tx.update(skills)
    .set({ ...patch, version: sql`${skills.version} + 1` })
    .where(and(eq(skills.id, id), eq(skills.workspaceId, workspaceId)))
    .returning();
  if (!next[0]) throw new NotFoundError('skill', id);
  await tx.insert(skillVersions).values({
    skillId: id,
    version: next[0].version,
    body: next[0].body,
  });
  return next[0];
});
```

`version: sql\`${skills.version} + 1\`` keeps the bump atomic, no read-modify-write race. `skill_versions` only snapshots `body` (matching the existing schema — extending it is a separate migration).

### Routes

```
GET    /skills              → list (workspace-scoped, ordered by created_at desc)   200
GET    /skills/:id          → one                                                    200 / 404
GET    /skills/:id/usage    → { agent_count: number }                                200 / 404
POST   /skills              → CreateBody                                             201
PATCH  /skills/:id          → UpdateBody (partial)                                   200
DELETE /skills/:id          → no body                                                204
```

### Zod schemas at the route boundary

```ts
const SkillType = z.enum(['rubric', 'convention', 'security', 'custom']);

const CreateBody = z.object({
  name:        z.string().min(1).max(120),
  description: z.string().max(500),
  type:        SkillType,
  body:        z.string().min(1),
  enabled:     z.boolean().optional().default(true),
});
const UpdateBody = CreateBody.partial();
const IdParams   = z.object({ id: z.string().uuid() });
```

422 on validation error is automatic (Fastify + Zod, per server/CLAUDE.md).

### Wire-up

- Register `skillsModule` in `server/src/modules/index.ts`.
- Add DI registration in `server/src/platform/container.ts`.
- Add a shared contract at `server/src/vendor/shared/contracts/skill.ts` (`Skill`, `SkillType`, `SkillSource`) — client and server share one source of truth; the agents module does this already.
- Export the contract from `server/src/vendor/shared/index.ts` and mirror in `client/src/vendor/shared/`.

### Client routes (new): `client/src/app/skills/`

Mirrors the structure of `client/src/app/agents/`:

```
src/app/skills/
  page.tsx                                    # server component shell
  _components/SkillsListView/
    SkillsListView.tsx                        # main client component
    SkillsListView.test.tsx
    SkillCard/                                # one card per skill
    SkillsToolbar/                            # search + type filter chips
    AddSkillButton/                           # button with create/import dropdown
    SkillPreviewDrawer/                       # right-side preview drawer
    DeleteSkillDialog/                        # confirm dialog with usage count
    styles.ts
    constants.ts                              # TYPE_COLORS, enum lists
    index.ts
  [id]/page.tsx
  [id]/_components/SkillEditor/
    SkillEditor.tsx
    SkillEditor.test.tsx
    MarkdownSplit/                            # <Textarea> + react-markdown preview
    styles.ts
    constants.ts
    index.ts
  new/page.tsx                                # reuses SkillEditor in 'create' mode

src/lib/hooks/skills.ts                       # useSkills / useSkill / useCreateSkill / useUpdateSkill / useDeleteSkill / useSkillUsage
src/vendor/shared/contracts/skill.ts          # mirror of server contract
```

### Touched client files

```
src/lib/api.ts                                # add skills endpoints
src/components/app-shell/helpers.ts           # ensure 'Skills' nav links to /skills (if not already)
messages/en.json (+ uk.json if present)       # skills.* i18n keys
src/vendor/shared/index.ts                    # export skill contract
```

## Components & data flow

### `SkillsListView`

Owns local state: `searchQuery`, `typeFilters: Set<SkillType>`, `selectedId: string | null` (controls drawer).

Layout, top → bottom:

1. `<PageShell title="Skills" actions={<AddSkillButton />} />` (reuse existing PageShell).
2. Toolbar: `<TextInput placeholder="Search skills…" />` + `<TypeFilterChips />`.
3. Grid of `<SkillCard />` cells — CSS grid, `minmax(280px, 1fr)`, gap 16.
4. Two distinct empty states: "No skills yet" (zero skills total) vs "No skills match this filter" (after filtering).
5. `<SkillPreviewDrawer skillId={selectedId} onClose={…} />`.

Drawer state is NOT in the URL — deep-linking to a preview is intentionally not supported. The full deep link is the editor route, `/skills/[id]`.

### `SkillCard`

Shows: name (mono), type badge (colored chip), description (truncated to 2 lines via `-webkit-line-clamp`), enabled toggle at the top-right.

- Card click → set `selectedId` (opens drawer).
- Toggle click → `stopPropagation`, then `useUpdateSkill({ id, patch: { enabled } })` with optimistic `onMutate` that flips the cached row instantly and rolls back on error.

### `AddSkillButton`

Primary item "Create" → `router.push('/skills/new')`.
Secondary item "Import" → disabled, tooltip "Coming soon".

### `SkillPreviewDrawer`

Right-aligned, ~480px wide. Header: name, type badge, kebab → "Delete…". Body: enabled toggle, description, rendered markdown body via `react-markdown`. Footer: primary "Edit" → `router.push('/skills/{id}')`.

Delete confirm reads from `useSkillUsage(id)` and shows `"Delete "{name}". Used by {agent_count} agents. This will remove it from those agents and delete its history."` Cascade does the actual removal.

### `SkillEditor`

Used by both `/skills/[id]` (mode = `edit`) and `/skills/new` (mode = `create`).

Form fields, using `@devdigest/ui` primitives:

- **Name** — `TextInput`, required (Zod `min(1).max(120)`).
- **Type** — `SelectInput` with the four enum values.
- **Description** — `TextInput`. Helper text below: *"Acts as the skill's interface — phrase it as a directive."*
- **Enabled** — `Toggle`.
- **Body (markdown)** — `MarkdownSplit`: `<Textarea mono rows={20} />` on the left, `react-markdown` rendered output on the right. A "Preview" toggle folds the preview pane on narrow widths.

Save → `useCreateSkill` (returns new id, navigates to `/skills/{id}`) or `useUpdateSkill` (shows `Saved (vN)` inline like the agent editor).

Unsaved-changes guard: `beforeunload` + a `dirty` flag with a "Discard changes?" dialog on intra-app navigation.

### Toggle data flow (illustrative)

```
SkillCard onChange(enabled)
  → useUpdateSkill.mutate({ id, patch: { enabled } })
    → onMutate: optimistically patch cached useSkills() row
    → fetch PATCH /skills/:id (api.ts)
    → server: repository.update() inside transaction
        → bump version
        → insert skill_versions row
        → update skills row
    → onSuccess: invalidate ['skills'] queries
    → onError: rollback cache, toast error
```

## Error handling & edge cases

**Server**:

- `NotFoundError('skill', id)` from service → 404 (matches the agents module mapping).
- Validation → 422 via Zod (automatic).
- Workspace isolation violations → 404 (not 403). Cross-workspace `id` looks identical to a missing id from the caller's perspective.

**Client**:

- TanStack Query mutations surface failures through the existing global error toast.
- Optimistic toggle rolls back on error.
- Editor save failure → inline error under save + toast.
- Delete failure → toast; drawer stays open so the user can retry.

**Edge cases**:

- Empty workspace → "No skills yet" empty state with primary "Create your first skill" button.
- Filter empties out → "No skills match this filter" empty state under the toolbar (clear-filter affordance).
- Very long markdown body → editor handles natively; preview pane scrolls independently. Card description truncates at 2 lines.
- Concurrent edits → last-write-wins. Out of scope for v1; revisit if reported.
- Deleting a skill linked to many agents → cascade removes the link rows; the agents themselves are untouched.
- Disabled skill → still listed, rendered dimmed; the enabled toggle works inline. Reviewer-core prompt assembly (later spec) is what actually skips disabled skills.
- Workspace scope is non-negotiable on every read and write.

**Routing**:

- `/skills` — list.
- `/skills/new` — create.
- `/skills/[id]` — edit.
- Selected drawer state is not in the URL.

**i18n**:

- All UI strings via `next-intl`. New keys under `skills.*` in `client/messages/en.json` (and `uk.json` if present).
- Keys: page title; toolbar (search placeholder, type filter chip labels); add button (`Create`, `Import`, `Coming soon` tooltip); card (enabled, type label per enum); drawer (edit, delete, confirm body with `{count}` interpolation); editor (each field label/hint, save button states, unsaved-changes dialog).

**A11y**:

- Cards are keyboard-focusable; Enter/Space activates the drawer.
- Drawer traps focus and closes on Esc.
- Toggle has an accessible label.
- Type is communicated by both colour (badge) and text label — colour is not the sole signal.

**Telemetry / logging**:

- Server: Fastify + Pino already logs request/response. No extra logs in Spec A.
- Client: no analytics; matches the rest of the app.

## Test plan

Server (vitest; `*.it.test.ts` = integration, hits real Postgres via `test/helpers/pg.ts`):

| File | Cases |
|---|---|
| `server/test/skills.it.test.ts` | create writes v1 + `skill_versions` row · update bumps version + writes history · delete cascades `skill_versions` and `agent_skills` · workspace isolation (skill in WS A invisible from WS B) · `usage` counts the `agent_skills` join correctly · update on missing id throws `NotFound` · update on cross-workspace id throws `NotFound` · HTTP round-trip for each route returns the expected status and body |
| `server/test/skills-routes.test.ts` | 422 on missing/invalid body fields · 404 on missing skill · 201 on create returns `{ id, version }` · 200 on PATCH returns `{ version }` · 204 on DELETE · 200 on `GET /skills/:id/usage` returns `{ agent_count }` |

Client (vitest + jsdom + RTL):

| File | Cases |
|---|---|
| `SkillsListView.test.tsx` | renders skills from `useSkills` · filters by search · filters by type · empty state for no skills · empty state for filtered-out · click card opens drawer · toggle on card calls `useUpdateSkill` and shows optimistic state |
| `SkillCard.test.tsx` | shows name / type badge / description / toggle · toggle click stops propagation · disabled skill renders dimmed |
| `SkillPreviewDrawer.test.tsx` | renders markdown body via react-markdown · Edit button navigates to `/skills/[id]` · kebab → Delete opens confirm with usage count · Esc closes |
| `SkillEditor.test.tsx` | create mode: required name, submit calls `useCreateSkill` and navigates · edit mode: submit calls `useUpdateSkill` and shows `Saved (vN)` · unsaved-changes guard fires on navigate-away · split markdown preview reflects body |

TanStack Query hooks (`lib/hooks/skills.ts`) are not tested in isolation — they are thin wrappers around `api.ts` and are covered through the component tests that consume them. This matches the existing client convention.

## Acceptance criteria

- A user in workspace A can create a skill via `/skills/new` and see it on `/skills`.
- Editing a skill at `/skills/[id]` increments its version and writes a `skill_versions` row.
- Toggling enabled on the list card optimistically updates the UI and persists.
- Deleting a skill removes it from the list and from any agents that linked it (cascade).
- A workspace B user cannot read, update, or delete a workspace A skill (404 on attempt).
- Type filter chips and search both filter the visible grid, combined with AND.
- The Import dropdown item is visible but disabled, with a "Coming soon" tooltip.
- All UI strings are routed through `next-intl`.

## Open questions

None at design time. Concurrency control and the history viewer are explicit deferrals.

## References

- Existing skills schema: [server/src/db/schema/skills.ts](../../../server/src/db/schema/skills.ts)
- Agent ↔ skill link routes (already shipped): [server/src/modules/agents/routes.ts](../../../server/src/modules/agents/routes.ts)
- Agent editor pattern this spec mirrors: [client/src/app/agents/[id]/_components/AgentEditor/](../../../client/src/app/agents/[id]/_components/AgentEditor/)
- Design reference (Skills tab inside Agent Editor): [docs/DevDigest Design (standalone).html](../../DevDigest%20Design%20%28standalone%29.html), frame "Agent Editor · Skills"

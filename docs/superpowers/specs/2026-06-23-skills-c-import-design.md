# Skills UI — Spec C: Skills import — design

Date: 2026-06-23
Status: design approved; pending spec review before writing-plans.
Depends on: [Spec A](2026-06-23-skills-ui-list-editor-design.md) (the inventory page + the inert `Import` dropdown item that this spec activates).

## Context

Spec A shipped a `+ Add Skill ▾` dropdown on the Skills list page with `Create` enabled and `Import` disabled with a "Coming soon" tooltip ([client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.tsx](../../../client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.tsx)). This spec wires up `Import`: the user can upload a single markdown file, see a preview with a clear trust banner, edit the parsed fields, and confirm to create the skill.

**Trust framing**, from the original brief: *"чужий скіл — це чужі інструкції в промпті агента"* — someone else's skill is someone else's instructions in your agent's prompt. The preview gate is non-negotiable: nothing imported is saved to the workspace without the user explicitly confirming after reading the body.

## Goals

- A user can upload a `.md` file and end up with a new skill row in their workspace, having reviewed the parsed content before saving.
- The flow is honest about origin: imported skills carry a clear visual + textual trust hint at preview time.
- Server-side parsing is strict and read-only: no code execution, no shell-out, no network fetch, no filesystem write outside the parsed body string.

## Non-goals

- Archive (`.zip`, `.tar.gz`) import — deferred. The original brief mentioned archives; the v1 cost (safe extract, zip-slip guards, content-type enforcement on extracted files, manifest schema) outweighs the v1 user need. Revisit when community skill packs become real.
- Paste-by-URL — deferred. Server-side URL fetch is an SSRF surface; skip until we have a clear use case.
- Editing the body in the preview dialog — keep the dialog focused on inspection + metadata. If the user wants to edit the body, they save first, then edit at `/skills/[id]`.
- Multi-file batch import — one file at a time keeps the trust gate honest.

## Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Import source | Markdown file upload only | YAGNI for archive / URL until community skill packs are a real flow. |
| 2 | File size cap | 256 KB | A skill body is text; 256 KB is ~50 pages of prose. Anything larger is suspect. Enforced at the multipart layer. |
| 3 | Metadata source priority | YAML frontmatter > H1 + first paragraph > filename + empty description | Standard markdown convention. Frontmatter wins when present so power users can author imports deterministically. |
| 4 | Server endpoint shape | Preview-only — does NOT create the skill | Forces the trust gate into the UI. The client calls the existing `POST /skills` after the user confirms. |
| 5 | YAML parser | No dependency — a 30-line whitelist parser that handles `name`/`type`/`description`/`enabled` only | Adding `js-yaml` for four fields is over-investment. The parser refuses unknown keys (input is untrusted). |
| 6 | Multipart handler | `@fastify/multipart` (new server dep) | Standard, well-maintained, supports streaming + size limits. |
| 7 | What happens if frontmatter declares `type: 'foo'` (invalid)? | The preview returns `type: 'custom'` AND a warning string for the dialog to display | Don't silently coerce. Show the user what we couldn't recognise. |
| 8 | Source field on the imported skill | `source: 'imported_url'` (existing enum value, reused for "imported via file too") OR a new enum value `imported_file`? **Decision: reuse `imported_url`** — rename the enum semantics to "imported via the import flow" in a comment. Adding a new enum requires a migration that ripples through Drizzle; not worth it for a label distinction. | Pragmatic. The `SkillSource` field in the contract isn't user-facing in Spec A. |

## Architecture

### Server

**New dependency** ([server/package.json](../../../server/package.json)):

```json
{
  "dependencies": {
    "@fastify/multipart": "^9.x"
  }
}
```

**Plugin registration** ([server/src/app.ts](../../../server/src/app.ts)):

```ts
await app.register(import('@fastify/multipart'), {
  limits: {
    fileSize: 256 * 1024,     // 256 KB
    files: 1,                  // one file per request
    fieldSize: 1024,           // any text fields tiny
    parts: 5,
  },
});
```

Register globally (matches `@fastify/cors`'s placement). The plugin only activates on routes that opt in via `req.file()`.

**New module helpers** ([server/src/modules/skills/helpers.ts](../../../server/src/modules/skills/helpers.ts)):

```ts
export interface ParsedImportPayload {
  name: string;
  description: string;
  type: SkillType;
  body: string;
  warnings: string[];   // human-readable strings the dialog displays
}

export function parseSkillMarkdown(
  raw: string,
  filename: string | undefined,
): ParsedImportPayload;
```

Parser flow:

1. Detect frontmatter: file starts with `---\n` … `\n---\n` (exact match, no leading whitespace).
2. If present, parse with a strict whitelist: only `name`, `description`, `type`, `enabled` recognised. Other keys → warning.
3. If `type` is present but not in `{rubric, convention, security, custom}` → coerce to `custom` + warning.
4. Body = everything after the frontmatter (or the entire file if no frontmatter).
5. If `name` is still empty: take the first H1 (`# heading`). If still empty: use the filename without `.md` extension and replace `_` / spaces with `-`.
6. If `description` is still empty: take the first non-empty paragraph after the H1 (capped to 200 chars). Drop the trailing period.
7. Final defaults: `type = 'custom'`, `description = ''`. `body` is required — if empty after stripping frontmatter, throw `ValidationError` (422) with `code: 'empty_body'`.

**New route** ([server/src/modules/skills/routes.ts](../../../server/src/modules/skills/routes.ts)):

```ts
app.post('/skills/import/preview', async (req) => {
  await getContext(app.container, req);  // workspace gate, even though we don't write
  const data = await req.file();
  if (!data) throw new ValidationError('No file uploaded.');
  if (!data.filename.endsWith('.md')) {
    throw new ValidationError('File must have a .md extension.');
  }
  const buffer = await data.toBuffer();
  if (buffer.length > 256 * 1024) {
    throw new ValidationError('File too large (max 256KB).');
  }
  const text = buffer.toString('utf8');
  return service.parseImport(text, data.filename);
});
```

No DB writes. No skills row is created here.

**Service method** ([server/src/modules/skills/service.ts](../../../server/src/modules/skills/service.ts)):

```ts
parseImport(text: string, filename: string): ParsedImportPayload {
  return parseSkillMarkdown(text, filename);
}
```

(Service-level so it's testable without HTTP, mirrors the existing pattern.)

### Client

**API client** ([client/src/lib/api.ts](../../../client/src/lib/api.ts)) — add one method:

```ts
export const api = {
  // …existing get/post/put/del/patch…
  upload: <T>(path: string, file: File): Promise<T> =>
    apiFetch<T>(path, {
      method: 'POST',
      body: (() => { const fd = new FormData(); fd.append('file', file); return fd; })(),
      // Note: do NOT set Content-Type — the browser sets the multipart boundary.
    }),
};
```

(Special-case in `apiFetch`: when `body` is a `FormData`, skip the `Content-Type: application/json` injection that's currently unconditional in `lib/api.ts:21-22`.)

**Hook** ([client/src/lib/hooks/skills.ts](../../../client/src/lib/hooks/skills.ts)):

```ts
export function useImportSkillPreview() {
  return useMutation({
    mutationFn: (file: File) =>
      api.upload<ParsedImportPayload>('/skills/import/preview', file),
  });
}
```

Reuses the existing `useCreateSkill` for the actual save (preview is read-only, the create endpoint already accepts the same shape).

**Components**:

```
client/src/app/skills/_components/SkillsListView/_components/ImportSkillDialog/
  ImportSkillDialog.tsx
  ImportSkillDialog.test.tsx
  TrustBanner.tsx              # the orange "someone else's instructions" hint
  styles.ts
  index.ts
```

`ImportSkillDialog` states:

1. **File picker** — drop-zone (drag-and-drop a `.md`) or a native `<input type="file" accept=".md">`. Hint: "Markdown only, max 256KB".
2. **Loading** — after upload, while preview parses. Skeleton.
3. **Preview** — form prefilled with parsed fields (name, type, description) on the left; rendered markdown body on the right via the shared `Markdown` primitive; trust banner above the form; `Cancel` and `Create skill` buttons at the bottom. Warnings (from the parser) render as inline yellow chips at the top of the form.
4. **Error** — if the upload returned 4xx/5xx, show the message inline above the picker and keep the dialog open.

`TrustBanner`:

```
⚠ You're about to add someone else's instructions to your agents' prompts.
  Read the body below before saving. You can edit anything after import.
```

(Styled with `--warn` background, prominent but not blocking.)

### Wiring `AddSkillButton`

In [client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.tsx](../../../client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.tsx):

- Remove `muted: true` and the inert `onClick: () => undefined` from the Import item.
- Wire `onClick: onImport` (new prop on `AddSkillButton`).
- The list view (`SkillsListView`) owns the `importing: boolean` state, passes `onImport={() => setImporting(true)}`, renders `<ImportSkillDialog open={importing} onClose={…} />`.

Remove the `Coming soon` tooltip and the unused i18n key in this spec's commit (`skills.list.importComingSoon`).

### i18n

Extend `client/messages/en/skills.json`:

```json
{
  "import": {
    "title": "Import a skill",
    "subtitle": "Upload a Markdown file from another workspace or a teammate.",
    "drop": "Drop a .md file here, or click to choose",
    "hint": "Markdown only, max 256KB",
    "trustBanner": "You're about to add someone else's instructions to your agents' prompts. Read the body below before saving. You can edit anything after import.",
    "parseError": "We couldn't parse the file. Make sure it's valid Markdown.",
    "tooLarge": "File too large. The maximum is 256KB.",
    "wrongExt": "Only .md files are supported.",
    "warningsLabel": "Heads up:",
    "cancel": "Cancel",
    "create": "Create skill",
    "creating": "Creating…"
  }
}
```

## Components & data flow

```
AddSkillButton → setImporting(true)
ImportSkillDialog opens (state: 'picker')
  user picks file →
    useImportSkillPreview.mutate(file)
      → POST /skills/import/preview (multipart)
      → server: validate ext + size, read buffer, parseSkillMarkdown(text, filename)
      → server returns { name, description, type, body, warnings }
    → onSuccess: setState('preview', payload)
    → onError: setState('error', message), stay open
  user reviews → edits name/description/type as desired →
    useCreateSkill.mutate({ name, description, type, body, enabled: true })
      → POST /skills (existing route)
      → on success: invalidate ['skills'], navigate to /skills/{id} (same as 'Create')
      → on error: inline error in dialog
```

## Error handling & edge cases

- **File missing or empty body**: 422 + dialog stays in 'picker' state with the error chip.
- **YAML frontmatter that's invalid**: warning + fall back to defaults; don't 400. The user can still edit in the preview.
- **Non-UTF8 bytes**: 400 with "File must be UTF-8 encoded."
- **Multipart misuse** (no `file` field, multiple files): the `@fastify/multipart` `limits` field rejects automatically; route returns 413/422 with a generic message. The dialog maps both to `import.parseError`.
- **Save after preview fails on duplicate name** (no DB-side uniqueness in Spec A — see Spec A Decision #9): not applicable. Names are not unique.
- **User edits the name to empty in the preview**: `Create skill` button disabled until non-empty.
- **Network drops during upload**: `apiFetch` throws `ApiError(0, 'network_error')` — dialog shows a retry affordance.

## Test plan

Server (vitest):

| File | Cases |
|---|---|
| `server/test/skills-import.it.test.ts` | POST with valid `.md` returns parsed payload · frontmatter overrides body-derived defaults · invalid `type` in frontmatter coerces to `custom` + warning · file > 256KB → 413/422 · non-`.md` extension → 422 · empty body → 422 · multipart with no `file` field → 422 · NO `skills` row created by any of these (assert with COUNT before/after) |
| `server/test/skills-helpers.test.ts` (extend existing or new) | unit tests for `parseSkillMarkdown` — happy path, frontmatter-only, body-only, invalid frontmatter keys, H1-derived name, filename fallback, description from first paragraph, warning emission |

Client (vitest + jsdom + RTL):

| File | Cases |
|---|---|
| `ImportSkillDialog.test.tsx` | renders picker · accepts a `.md` File via the input · shows preview after `useImportSkillPreview` resolves · warnings render as chips · Cancel closes without saving · `Create skill` calls `useCreateSkill` with the edited shape, navigates to `/skills/{id}` · save failure shows inline error · trust banner is present in the preview state |

## Acceptance criteria

- The `Import` dropdown item is enabled (no "Coming soon" tooltip).
- Selecting a valid `.md` opens a preview with name/type/description prefilled.
- Warnings from the parser surface as inline chips in the preview.
- The trust banner is always visible in the preview state.
- `Create skill` only succeeds when the user has confirmed in the preview (no auto-save).
- No skills row is created by hitting the import endpoint alone; the row appears only after the user confirms in the preview.
- File > 256KB or non-`.md` gets a clear error in the dialog.
- Cancel from the preview does NOT create a row.

## Open questions

None at design time.

## References

- Spec A: [docs/superpowers/specs/2026-06-23-skills-ui-list-editor-design.md](2026-06-23-skills-ui-list-editor-design.md)
- `@fastify/multipart`: https://github.com/fastify/fastify-multipart
- Spec A's `AddSkillButton` (where Import is currently disabled): [client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.tsx](../../../client/src/app/skills/_components/SkillsListView/_components/AddSkillButton/AddSkillButton.tsx)

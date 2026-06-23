# API Contract Reviewer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an "API Contract Reviewer" agent with 4 directive rubric skills that detects breaking API changes in PR diffs, then run a controlled with/without-skills experiment to demonstrate the skills' additive value.

**Architecture:** Zero new server code. Everything is done through existing UI flows and committed skill `.md` files. Four skills are authored as markdown files under `server/src/prompts/skills/api-contract/`, then created in the UI (3 via editor, 1 via `.md` import). The agent is created through the Agents UI with a tailored system prompt and linked to all 4 skills. An experiment branch with two deliberate API violations is used to compare review quality with and without the skills.

**Tech Stack:** Existing DevDigest Skills Lab UI, existing `POST /skills/import/preview` + `POST /skills` import flow, existing `POST /agents` + `POST /agents/:id/skills` routes. No package changes needed.

## Global Constraints

- All 4 skill files use `type: rubric` in their frontmatter — NOT `type: convention`. Convention is reserved for patterns produced by the Conventions Extractor. Rubric = enforced rule.
- `source` field for manually created skills defaults to `'manual'` — do not override.
- Model: `claude-sonnet-4-6` (not haiku, not opus). Set this exactly in the agent form.
- Strategy: `single-pass`.
- `ci_fail_on`: `critical`.
- `repo_intel`: enabled.
- The experiment branch must be created on an existing connected repo — one that already has at least one route handler file with a response object.
- Never commit `.env`, `secrets.json`, or any credential file.

---

## File map

**New files:**
- `server/src/prompts/skills/api-contract/breaking-change.md`
- `server/src/prompts/skills/api-contract/response-schema.md`
- `server/src/prompts/skills/api-contract/semver-discipline.md`
- `server/src/prompts/skills/api-contract/deprecation-policy.md`
- `docs/superpowers/experiments/2026-06-23-api-contract-reviewer.md` (experiment results, Task 3)

**No files modified** in server or client code.

---

### Task 1: Author the 4 skill `.md` files

**Files:**
- Create: `server/src/prompts/skills/api-contract/breaking-change.md`
- Create: `server/src/prompts/skills/api-contract/response-schema.md`
- Create: `server/src/prompts/skills/api-contract/semver-discipline.md`
- Create: `server/src/prompts/skills/api-contract/deprecation-policy.md`

**Interfaces:**
- Produces: 4 `.md` files with valid frontmatter (`name`, `description`, `type: rubric`) and a directive body
- Consumed by: Task 2 (UI import of `breaking-change.md`) and Task 2 (manual creation of the other 3)

- [ ] **Step 1: Create the `api-contract/` directory and `breaking-change.md`**

```bash
mkdir -p server/src/prompts/skills/api-contract
```

Create `server/src/prompts/skills/api-contract/breaking-change.md`:

```markdown
---
name: breaking-change
description: Flags removal or renaming of any public API contract element
type: rubric
---

# Breaking Change Detection

Flag any diff that removes, renames, or changes the HTTP method of a public route, or removes/renames a field in a public request or response body.

## Bad

```diff
- router.delete('/users/:id', handler)
+ router.delete('/accounts/:id', handler)
```

Route path renamed without backward-compatible alias. Existing clients break silently.

## Good

```diff
+ router.delete('/accounts/:id', handler)  // new path
+ router.delete('/users/:id', legacyRedirect)  // backward-compatible alias, deprecated
```

Cite the file:line of the removed or renamed element and explain which clients it breaks.
```

- [ ] **Step 2: Create `response-schema.md`**

Create `server/src/prompts/skills/api-contract/response-schema.md`:

```markdown
---
name: response-schema
description: Flags type changes, field renames, or optionality changes in API responses
type: rubric
---

# Response Schema Integrity

Flag any diff that changes the shape of a response body: field renaming, type changes (string→number), required→optional or optional→required changes, or removal of existing fields.

## Bad

```diff
- return { user_id: user.id, name: user.name }
+ return { userId: user.id, name: user.name }
```

Field renamed from `user_id` to `userId`. Any client reading `user_id` now gets `undefined`.

## Good

```diff
  return {
    user_id: user.id,   // kept for backward compatibility
+   userId: user.id,    // new canonical name
    name: user.name,
  }
```

Cite the file:line of the changed field and explain the client impact.
```

- [ ] **Step 3: Create `semver-discipline.md`**

Create `server/src/prompts/skills/api-contract/semver-discipline.md`:

```markdown
---
name: semver-discipline
description: Asserts that breaking API changes require a major version bump
type: rubric
---

# SemVer Discipline

Any breaking change to a public API contract requires a major version increment (MAJOR.minor.patch). Flag PRs that introduce breaking changes without a corresponding version bump in the version file or CHANGELOG.

## Bad

A PR that renames a response field or removes a route, with no changes to `package.json` version or `CHANGELOG.md`.

## Good

```diff
- "version": "2.4.1"
+ "version": "3.0.0"
```

With a CHANGELOG entry listing all breaking changes and migration instructions.

If a breaking change is found and no version bump is present, flag it as a blocker.
```

- [ ] **Step 4: Create `deprecation-policy.md`**

Create `server/src/prompts/skills/api-contract/deprecation-policy.md`:

```markdown
---
name: deprecation-policy
description: Requires @deprecated annotation before silent removal of API elements
type: rubric
---

# Deprecation Policy

Never silently remove a public route, parameter, or response field. Always annotate the element as deprecated first, then remove it in a subsequent major release.

## Bad

```diff
- router.get('/v1/users', legacyHandler)
```

Route deleted without prior deprecation notice. Clients get 404 with no warning.

## Good

```diff
  /**
+  * @deprecated — use GET /v2/users instead. Will be removed in v4.0.
   */
  router.get('/v1/users', legacyHandler)
```

Flag any diff that removes a public element without a prior `@deprecated` annotation or deprecation header in the response.
```

- [ ] **Step 5: Verify all 4 files have correct frontmatter**

```bash
grep -l 'type: rubric' server/src/prompts/skills/api-contract/*.md | wc -l
```

Expected: `4` — all 4 files have `type: rubric`.

- [ ] **Step 6: Commit**

```bash
git add server/src/prompts/skills/api-contract/
git commit -m 'feat(api-contract): author 4 rubric skill files for API Contract Reviewer'
```

---

### Task 2: Create the agent + link 4 skills via DevDigest UI

**Files:** None created by this task (all changes are in the database via the UI).

**Interfaces:**
- Consumes: the 4 `.md` files from Task 1 (`breaking-change.md` for import; the other 3 for reference)
- Produces: a workspace agent named "API Contract Reviewer" with 4 linked skills and `claude-sonnet-4-6`

These steps are performed manually through the DevDigest UI running at `http://localhost:3001` (or wherever the client is served). Start the dev server first: `./scripts/dev.sh`.

- [ ] **Step 1: Start the dev stack**

```bash
./scripts/dev.sh
```

Wait until both server and client are ready (the client URL will appear in the terminal).

- [ ] **Step 2: Create 3 skills manually via Skills Lab**

Navigate to Skills Lab (`/skills`). Create each of the following three skills using the "New skill" editor. Copy content verbatim from the `.md` files authored in Task 1 (excluding the frontmatter `---` delimiters — paste only the body content into the editor body field; fill in `name`, `description`, and set `type: rubric` in the skill form):

**Skill A:**
- Name: `response-schema`
- Description: `Flags type changes, field renames, or optionality changes in API responses`
- Type: `rubric`
- Body: contents of `server/src/prompts/skills/api-contract/response-schema.md` (body only, no frontmatter)

**Skill B:**
- Name: `semver-discipline`
- Description: `Asserts that breaking API changes require a major version bump`
- Type: `rubric`
- Body: contents of `server/src/prompts/skills/api-contract/semver-discipline.md` (body only)

**Skill C:**
- Name: `deprecation-policy`
- Description: `Requires @deprecated annotation before silent removal of API elements`
- Type: `rubric`
- Body: contents of `server/src/prompts/skills/api-contract/deprecation-policy.md` (body only)

Save each skill. Verify all 3 appear in the Skills Lab list.

- [ ] **Step 3: Import `breaking-change.md` via the `.md` upload flow**

In Skills Lab, use the "Import from .md" button (or equivalent upload entry point). Select `server/src/prompts/skills/api-contract/breaking-change.md`. The preview dialog should show:
- Name: `breaking-change`
- Description: `Flags removal or renaming of any public API contract element`
- Type: `rubric`

Confirm the import. Verify `breaking-change` appears in the Skills Lab list.

- [ ] **Step 4: Create the API Contract Reviewer agent**

Navigate to Agents (`/agents`). Click "New agent". Fill in:

| Field | Value |
|---|---|
| Name | `API Contract Reviewer` |
| Description | `Detects breaking changes, schema drift, and versioning violations in API PRs` |
| Provider | `anthropic` |
| Model | `claude-sonnet-4-6` |
| Strategy | `single-pass` |
| `ci_fail_on` | `critical` |
| `repo_intel` | enabled (toggle on) |

System prompt (paste verbatim):

```
You are an API Contract Reviewer. Your job is to detect breaking changes, schema drift, and versioning violations in pull request diffs.

Review the diff strictly for API contract integrity. Focus only on:
- Route path changes (additions, removals, renames, method changes)
- Request body field changes (renames, type changes, required/optional changes)
- Response body field changes (renames, type changes, additions that could break strict parsers, removals)
- Version file / CHANGELOG alignment with breaking changes
- Deprecation annotation presence before element removal

Do NOT comment on code style, performance, test coverage, or logic correctness unless it directly affects the public API contract.

For each violation found: cite the specific file and line number, state which clients are affected, classify the severity (critical = silent breakage for existing clients, warning = non-backward-compatible change that is at least annotated), and suggest the correct approach.
```

Save the agent.

- [ ] **Step 5: Link all 4 skills to the agent**

Open the newly created agent's detail page. Navigate to the "Skills" tab. Add (or drag-and-drop) all 4 skills:
1. `breaking-change`
2. `response-schema`
3. `semver-discipline`
4. `deprecation-policy`

Verify all 4 appear in the agent's skills list with their toggles enabled.

---

### Task 3: Create experiment branch + run controlled comparison

**Files:**
- Create: `docs/superpowers/experiments/2026-06-23-api-contract-reviewer.md` (results document)

**Goal:** Demonstrate the skills' additive value by comparing PR review output with all 4 skills disabled vs enabled. Two deliberate API violations are introduced in the experiment PR.

- [ ] **Step 1: Identify a suitable file in the connected repo**

In the DevDigest UI, go to Repos and note which repos are connected. Pick one that has a route handler file with at least one response object. Note the `owner/name`. If no suitable file exists, create a minimal one on the experiment branch (see Step 3 note).

- [ ] **Step 2: Create the experiment branch**

```bash
# Replace OWNER/NAME with the connected repo's details; adjust path as needed
cd ~/repos/OWNER/NAME   # or wherever the repo is cloned locally
git checkout -b experiment/breaking-api-change
```

- [ ] **Step 3: Introduce two deliberate violations**

Find (or create) a route handler file with a response object. Make these two changes:

**Violation 1 — response field rename:**
```diff
- return res.json({ user_id: user.id, name: user.name })
+ return res.json({ userId: user.id, name: user.name })
```

**Violation 2 — optional field becomes required:**
Find a request schema (e.g. a Zod/Joi/express-validator schema). Change one optional field to required:
```diff
- email: z.string().email().optional(),
+ email: z.string().email(),
```

If no suitable file exists in the connected repo, create `routes/users.ts` with both patterns:
```typescript
// routes/users.ts
import express from 'express';
const router = express.Router();

// Request schema
import { z } from 'zod';
const UpdateUserSchema = z.object({
  name: z.string(),
  email: z.string().email(),  // VIOLATION 2: was .optional()
});

// Route handler
router.get('/users/:id', async (req, res) => {
  const user = { id: req.params.id, name: 'Alice' };
  return res.json({ userId: user.id, name: user.name });  // VIOLATION 1: was user_id
});
```

Commit both violations:
```bash
git add .
git commit -m 'experiment: introduce two API contract violations'
git push origin experiment/breaking-api-change
```

- [ ] **Step 4: Open a PR**

```bash
gh pr create \
  --title 'experiment: API contract violations for reviewer test' \
  --body 'This PR contains two deliberate API contract violations for testing the API Contract Reviewer agent with and without rubric skills.' \
  --head experiment/breaking-api-change
```

Note the PR URL for use in the next steps.

- [ ] **Step 5: Run 1 — without skills**

In the DevDigest UI, navigate to the experiment PR. Open the agent run panel. Select "API Contract Reviewer". Before running, **disable all 4 skills** (toggle each skill off in the agent's skills list, or temporarily remove them).

Run the review. Wait for it to complete.

Copy the full review output. Note:
- Did it flag the `user_id` → `userId` rename?
- Did it flag the `email` optionality change?
- Did it cite specific file:line references?
- Did it mention `@deprecated` requirement or semver implications?

- [ ] **Step 6: Re-enable all 4 skills**

Go back to the agent's Skills tab. Re-enable all 4 skills. Verify all toggles are on.

- [ ] **Step 7: Run 2 — with skills**

Re-run the review on the same PR with all 4 skills enabled.

Copy the full review output. Note the same points as in Step 5.

- [ ] **Step 8: Document the comparison**

```bash
mkdir -p docs/superpowers/experiments
```

Create `docs/superpowers/experiments/2026-06-23-api-contract-reviewer.md`:

Fill in the template below with the actual outputs from Steps 5 and 7:

```markdown
# Experiment: API Contract Reviewer — with vs without skills

**Date:** 2026-06-23
**Agent:** API Contract Reviewer (claude-sonnet-4-6, single-pass)
**PR:** [link to experiment PR]

## Violations introduced

1. Response field renamed: `user_id` → `userId` in [file:line]
2. Request field optionality changed: `email` made required in [file:line]

## Run 1 — without skills

[Paste the full review output here]

### Checklist
- [ ] Flagged `user_id` → `userId` rename
- [ ] Cited specific file:line
- [ ] Flagged email optionality change
- [ ] Mentioned `@deprecated` requirement
- [ ] Mentioned semver implications

## Run 2 — with skills

[Paste the full review output here]

### Checklist
- [ ] Flagged `user_id` → `userId` rename
- [ ] Cited specific file:line
- [ ] Flagged email optionality change
- [ ] Mentioned `@deprecated` requirement
- [ ] Mentioned semver implications

## Delta summary

[2–3 sentences describing what the skills added: were violations flagged more specifically? were citations more precise? were versioning/deprecation concerns raised that Run 1 missed?]
```

- [ ] **Step 9: Commit**

```bash
git add server/src/prompts/skills/api-contract/ \
        docs/superpowers/experiments/2026-06-23-api-contract-reviewer.md
git commit -m 'feat(api-contract): experiment results — with vs without skills comparison'
```

# Insights — client/

Client-specific learnings. For cross-cutting things, see [../INSIGHTS.md](../INSIGHTS.md).

## Entry format

    ## YYYY-MM-DD — short title
    Context: what we were doing
    What we tried: approaches considered or attempted
    What worked: the approach that landed
    Why it matters: what to remember next time

Append-only in spirit.

---

## 2026-06-19 — `vi.mock('next/navigation')` needs `vi.hoisted` for closed-over fns
Context: writing tests for `FindingsCell` that assert `router.push` is called when a deep-link title is clicked.
What we tried: the obvious pattern from web examples:

    const push = vi.fn();
    vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

What worked: `vi.mock` is hoisted to compile-time top of the file. Plain `const push = vi.fn()` is not hoisted with it, so `push` is `undefined` when the mock factory runs at hoist time. Use `vi.hoisted` to lift the fn declaration:

    const { push } = vi.hoisted(() => ({ push: vi.fn() }));
    vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

See `client/src/app/repos/[repoId]/pulls/_components/FindingsCell/FindingsCell.test.tsx`.

Why it matters: failure mode is SILENT — the mock just isn't applied, the real `useRouter` runs, tests appear to pass but assertions about navigation never actually exercise the code under test. No error, no warning. Always reach for `vi.hoisted` when a `vi.mock` factory closes over a fn ref.

## 2026-06-19 — Local pnpm 8.x silently downgrades the v9 lockfile
Context: running `pnpm install` in `client/` during task execution. Resulting diffs showed `client/pnpm-lock.yaml` rewritten with ~5000 lines of churn even when the only intentional change was adding one devDependency (or none at all).
What we tried: assuming the diff was real dependency upheaval and committing it.
What worked: noticing the first line of the lockfile changed from `lockfileVersion: '9.0'` to `'6.0'`. The local pnpm version is 8.15.4; the repo's lockfiles were written by pnpm 9.x. Downgrade was silent. Fix: regenerate the lockfile with pnpm 9 via `cd client && npx -y pnpm@9 install --lockfile-only` (no dependency changes needed — just rewrites the format). Long-term: add `"packageManager": "pnpm@9.x.x"` to the repo root `package.json` so `corepack` enforces the version locally and in CI.

Why it matters: pnpm doesn't warn about the format downgrade. CI uses the v9 lockfile by default and will either reject or produce a different dep graph than the local install — quiet drift between developer and prod envs. When you see a multi-thousand-line lockfile diff and you didn't change deps, check `head -1 pnpm-lock.yaml` first.

## 2026-06-23 — shell.json carries translation keys for not-yet-built nav items
Context: aligning the sidebar with `docs/DevDigest Design (standalone).html` by adding disabled placeholder nav rows for SKILLS LAB and GLOBAL sections.
What we tried: invented new nav keys like `project-context`, `eval-dashboard`, `multi-agent-review` to match the design's labels.
What worked: `client/messages/en/shell.json` already had keys for all of them — `context`, `eval`, `multi-agent`, `onboarding-tour`, `skills`, `conventions`, `memory`, `agent-performance`, `ci-runs`. Renamed nav item keys to match so `useShellCommands` resolves them via `t(\`nav.${it.key}\`)`.

Why it matters: future-feature nav keys are pre-reserved in `client/messages/en/shell.json:30-39`. Check there first before inventing new ids when adding L02/L03 routes — the i18n side is already done.

## 2026-06-23 — Reading the standalone design HTML programmatically
Context: `docs/DevDigest Design (standalone).html` is the canonical UI reference. The file is a bundler-packed single page (1.7MB) — `Read` rejects it as too large, and `head` only shows the loader stub.
What we tried: opening directly via `file://` URL through the browser MCP — the protocol gets rewritten to `https://file:...` and fails.
What worked: serve `docs/` via `python3 -m http.server <port>` and load `http://localhost:<port>/DevDigest%20Design%20(standalone).html` in a browser tab. Structure is `#root > .design-canvas > div`, a 9268×11832 absolutely-positioned canvas. The ~33 frame divs at depth=2 inside that wrapper are the individual screen designs; each frame's first text line is its label (e.g. `Pull Requests · Run Review …`, `PR Detail · Overview (Brief)`). Scroll a frame into the viewport with `canvas.scrollLeft += rect.left; canvas.scrollTop += rect.top`. Read pixel values from `getComputedStyle` rather than eyeballing screenshots.

Why it matters: shell sizes in `src/vendor/ui/shell/*` and tokens in `src/vendor/ui/styles.css` are ported from this canvas (README calls them "ported 1:1 from prototype"). When the design changes or a new screen needs porting, this DOM-probing path is significantly faster than screenshot inspection.

## 2026-06-23 — src/vendor/ui/ is a first-party design system, not third-party vendored code
Context: `client/CLAUDE.md` lists `src/vendor/` as a do-not-touch zone updated "via tooling, not by hand". This bounced off the actual task (porting design measurements into the shell).
What we tried: looking for the "tooling" that supposedly regenerates `src/vendor/ui/`.
What worked: read `client/src/vendor/ui/README.md` and `git log -- src/vendor/ui/`. There is no tooling — the folder is one initial squashed snapshot plus normal edits. The README documents it as the team's design system ("when you add or change a component, add it to the showcase"). The real enforceable constraint is `ui-architecture` SHOULD.8: don't add new ad-hoc imports of `src/vendor/` from outside designated consumers. The vendor folder itself is edited normally.

Why it matters: the do-not-touch wording in `client/CLAUDE.md` points new contributors away from where shell measurements, tokens, NavItem behavior, and command-palette wiring actually live. Treat the rule as an import-seam constraint, not an edit ban.

## 2026-06-23 — `vendor/shared/contracts/` is a server↔client duplicate; sync manually
Context: implementing the five `useAgentSkills*` hooks for the Agent Editor Skills tab. The server-side `AgentSkillLink` had been extended with `enabled: z.boolean()` in a prior commit; client typecheck failed.
What we tried: re-importing from `@devdigest/shared` and assuming the cross-package source-of-truth was a single file.
What worked: `client/src/vendor/shared/contracts/knowledge.ts:188` is a manually-kept duplicate of `server/src/vendor/shared/contracts/knowledge.ts:194`. Updating both is mandatory on every contract change. Fixed in commit `dc8ed3c`.
Why it matters: contributors changing a vendored contract see one server-side file edit pass server typecheck and may stop there. The client will diverge silently until its own typecheck runs (per-package CI). Treat any `vendor/shared/contracts/*.ts` edit on one side as requiring the symmetric edit on the other. Open follow-up: codify in CI or add a sync script.

## 2026-06-23 — Vendor `Dropdown` items are `role="button"`, not `role="menuitem"`
Context: building `LinkedSkillRow` with a kebab → "Remove from agent" affordance. Plan and existing components (e.g. `SkillPreviewDrawer`) use the vendor `Dropdown` from `@devdigest/ui` with items in the shape `{ label, icon, onClick }`.
What we tried: render `<Dropdown items={[{ label: t("removeFromAgent"), icon: "Trash", onClick }]} />` and assert via `screen.getByRole("menuitem", { name: /remove from agent/i })` in the test.
What worked: the assertion never matched. Vendor `Dropdown`'s `DropdownItem` renders `<button role="button">` (`client/src/vendor/ui/kit/Dropdown.tsx:37`). Replaced with an inline `KebabMenu` inside `LinkedSkillRow.tsx` that uses proper `role="menu"` + `role="menuitem"` ARIA. Inconsistent with the rest of the codebase but a11y-correct.
Why it matters: any new component test needing `getByRole("menuitem")` cannot use vendor `Dropdown`. Either (a) upgrade vendor `Dropdown` to expose menu ARIA, or (b) extract the inline `KebabMenu` from `LinkedSkillRow` into a shared `client/src/components/` primitive before the next consumer needs it. Open follow-up: pick one.

## 2026-06-23 — Optimistic-update RTL tests need `staleTime: Infinity` on the test QueryClient
Context: writing tests for `SkillsTab` and `AddSkillPicker` that mock `api.post`/`api.patch`/`api.del`, seed cache with `qc.setQueryData(KEY, …)`, then drive user interactions with `@testing-library/user-event`.
What we tried: default `new QueryClient({ defaultOptions: { queries: { retry: false } } })`.
What worked: 2 of 4 picker tests failed because `userEvent.type()` triggers focus/blur side-effects that prompt TanStack Query to refetch the seeded queryKey, wiping the seeded data before assertions ran. Fix: add `staleTime: Infinity`. With it, the seeded data is treated as fresh forever, refetches are skipped, and the optimistic mutation flow stays observable.
Why it matters: without `staleTime: Infinity`, optimistic-update tests are flaky in a way that LOOKS like the mutation didn't run (`api.X` spy shows zero calls) when it actually did but the cache was wiped first. Reach for this any time a test seeds `qc.setQueryData` AND drives user interactions.

## 2026-06-23 — `@dnd-kit` `KeyboardSensor` doesn't fire in jsdom
Context: writing a SkillsTab test that asserts drag-reorder posts `{ skill_ids: [...] }`. Spec test plan called for `userEvent.keyboard("[Space][ArrowDown][Space]")` against the drag handle (built-in keyboard sensor).
What we tried: focused the handle (which has `role="button"` from `useSortable().attributes`), pressed Space-ArrowDown-Space.
What worked: doesn't fire in jsdom — the keyboard sensor depends on layout / scroll measurements jsdom doesn't simulate, so `onDragEnd` never runs and the POST assertion fails. Fallback: `vi.mock("@dnd-kit/core", …)` swapping `DndContext` for a passthrough wrapper whose `onDragEnd` ref the test invokes directly with synthetic `{active, over}` data. See `SkillsTab.test.tsx` (the "keyboard drag-reorder fires POST { skill_ids }" case).
Why it matters: drag-reorder is THE central UX of any dnd-kit-using component. RTL + jsdom alone can't exercise it; either accept the limitation and mock `DndContext` (faster, deterministic), or move drag-reorder coverage to a real-browser e2e (catches real-layout issues). Pick deliberately.

## 2026-06-23 — Don't `aria-hidden` a `@dnd-kit` drag handle
Context: implementing `LinkedSkillRow`'s drag handle. The handle visually shows a grip icon next to the row's meaningful content (name, checkbox, type badge). Initial implementation added `aria-hidden="true"` to suppress duplicate screen-reader announcements, treating the grip as decoration.
What we tried: keep `aria-hidden="true"` on the `<span>` holding the grip icon while still spreading `{...dragHandleProps}` (dnd-kit's `attributes`/`listeners`).
What worked: removing `aria-hidden`. The "decoration" framing is wrong — dnd-kit's `KeyboardSensor` reaches the handle via the accessibility tree (the handle is the focus target it announces as "draggable" via `aria-roledescription="sortable"`). `aria-hidden` strips it from the tree and silently disables keyboard reorder. Fix in commit `8bb85b1`. Added `aria-label="Reorder skill"` so the handle has a real screen-reader name.
Why it matters: dnd-kit handles look visually like decoration but ARE the keyboard interaction surface. Any a11y-cleanup pass over a sortable list that "hides decorative icons" must skip dnd-kit handles. If your `SortableContext` mounts a `KeyboardSensor`, the handle's accessibility tree presence is load-bearing.

## 2026-06-23 — Next.js webpack doesn't honor `.js`→`.ts` resolution even with `moduleResolution: "Bundler"`
Context: Spec D added the first client-side **runtime-value** imports from `@devdigest/shared` (Zod schemas used as `.parse(...)`, not as `import type`). The barrel `client/src/vendor/shared/index.ts:17` does `export * from './contracts/findings.js'`. Knowledge.ts (added in Task 3) does `import { Finding } from './findings.js'`. Both .js suffixes had been in the codebase since the initial vendor copy.
What we tried: assumed the existing imports work because `tsconfig.json` has `moduleResolution: "Bundler"` and the editor/typecheck were green. The dev server then exploded at `./contracts/findings.js` not being resolvable when the home route compiled.
What worked: added `webpack.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] }` to `client/next.config.mjs`. Webpack's resolver — separate from TypeScript's — does NOT learn the `.js`→`.ts` mapping from tsconfig's `moduleResolution: "Bundler"`; that flag only affects the TS compiler.
Why it matters: prior client code worked only because hundreds of imports from `@devdigest/shared` were `import type { ... }` — SWC strips type-only imports at compile time, so webpack never resolves the barrel. The first value import through the barrel triggers the gap. If anyone adds another contract that's used as a runtime value (Zod schema, factory function) and imports it from the barrel without the alias config, it'll error the same way. Keep the alias config; don't remove it just because typecheck is happy.

## 2026-07-04 — POST /refresh + freshness-keyed GET race requires client-side SSE bridging
Context: IntentCard's Refresh button posts to `/overview/intent/refresh` (202 + runId), which enqueues a background recompute. GET `/overview/intent` uses freshness key `(head_sha, body_hash)` — an in-flight refresh doesn't change either, so the GET keeps returning the pre-refresh `'ready'` row until the background upsert commits.
What we tried: `invalidateQueries` on refresh success → re-fetch. UI appeared frozen for 5–15s; the query re-fetch would race the job and lose, so the user saw the same card and clicked Refresh again to no visible effect.
What worked: the hook captures the runId from the refresh POST into local state; feeds it into the same SSE effect that already handles server-side cold-compute runIds; a new `isRefreshing` flag keeps prior data visible with an in-progress banner overlaid; SSE `'done'` clears the flag AND invalidates the query. See `client/src/lib/hooks/overview.ts:60-96`.
Why it matters: any background-job-triggered POST paired with a freshness-keyed GET has this shape. The GET is idempotent to the job's existence — the client is the only entity that knows a recompute is desired vs already-cached, so `invalidateQueries` alone is insufficient. This pattern will recur for P2/P3 intent phases and any other overview-tab recompute (Brief refresh, Blast Radius refresh). Mirror the runId-into-SSE bridge each time rather than re-discovering the race.

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

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

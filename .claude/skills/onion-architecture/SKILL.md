---
name: onion-architecture
description: "DevDigest server/ Onion architecture rules. Use when editing or reviewing files under server/src/ — routes, modules, adapters, platform. Enforces inward-pointing dependencies and the boundary between business logic and external integrations."
---

# Onion Architecture (server/)

The server is layered: **routes** (Fastify handlers) → **modules** (services + domain) → injected via the `platform/container.ts` DI container. **Adapters** sit at the edge (LLM, GitHub, git, secrets, indexers). Dependencies point inward.

Companion to `server/CLAUDE.md`; this is the enforceable form.

## Severity

- **MUST** — blocker. The `pr-self-review` workflow flags MUST violations as blockers; Claude must address before claiming work ready.
- **SHOULD** — advisory. Listed in the final review summary; does not block.

---

## Rules

### MUST.1 — No adapter import in route handlers
Why: Routes are an HTTP-shaped delivery surface. Business logic and external boundaries belong in services; adapters reach the service through the container.
Red flag: a file under `server/src/` that registers Fastify routes (`fastify.get`, `fastify.post`, etc.) importing from `server/src/adapters/`.

### MUST.2 — No raw `fetch` / `octokit` / `simple-git` / `fs` / network calls in `modules/`
Why: Every external boundary has exactly one adapter; modules consume the adapter interface, never the underlying library.
Red flag: under `server/src/modules/`, an import of `octokit`, `simple-git`, `node:fs`, `node:fs/promises`, or a call to global `fetch(`.

### MUST.3 — No `throw new Error()` in routes or modules
Why: Errors must extend a typed class from `platform/errors.ts` so the boundary can map to HTTP status and structured logs.
Red flag: `throw new Error(` under `server/src/modules/` or in any Fastify route handler.

### MUST.4 — No cross-module imports between `modules/X` ↔ `modules/Y`
Why: Modules are bounded contexts. Shared domain helpers live in `modules/_shared/`; cross-module orchestration goes through a port wired by the container.
Red flag: a file at `server/src/modules/X/...` importing from `server/src/modules/Y/...` for any `X ≠ Y` and `Y ≠ _shared`.

### MUST.5 — No adapter-to-adapter imports
Why: Adapters are leaves. If A needs B, the shared concern is platform-level or the orchestration is a module's job.
Red flag: a file at `server/src/adapters/A/...` importing from `server/src/adapters/B/...` for any `A ≠ B`.

### MUST.6 — All routes register Zod schemas at the request boundary
Why: Invalid input is rejected at the seam (422), never propagates inward.
Red flag: a Fastify route declared without a `schema:` or `attachValidation`-equivalent on its body/query/params.

### SHOULD.7 — DI wiring lives in `platform/container.ts`
Why: Boot-time construction of adapters in exactly one place; test substitution stays sane.
Rule: no `new XAdapter()` outside `platform/container.ts`.
Red flag: `new SomethingAdapter(` outside `platform/container.ts`.

### SHOULD.8 — `adapters/mocks.ts` is test-only
Why: Production code that reaches into a mock is a latent bug.
Red flag: import of `server/src/adapters/mocks` from a non-test file (i.e., not `*.test.ts` or `*.it.test.ts`).

### SHOULD.9 — Settings-driven state read per request, never cached at boot
Why: LLM provider is selected per request from settings. Boot-time capture freezes the wrong value.
Red flag: a module-level `const llm = container.llm()` or equivalent in module/service code.

### SHOULD.10 — Integration tests: `*.it.test.ts` + `test/helpers/pg.ts`
Why: CI splits on the `.it.test.ts` suffix; the helper provides a real Postgres for assertions.
Red flag: a test file whose name does not end in `.it.test.ts` but imports `testcontainers` or `pg.ts`; or one that ends in `.it.test.ts` but does not import the helper.

---

## Principles & rationale

- **Dependencies point inward.** Routes depend on modules; modules depend on the container interface; adapters depend on nothing inside the app. Drawing an arrow outward is a smell.
- **One adapter per external concern.** `octokit` is wrapped exactly once; nothing else mentions it. The same goes for `simple-git`, `fs`, the LLM client.
- **Errors are typed.** A raw `throw new Error('...')` is information loss at the boundary; even a one-line subclass of a `platform/errors.ts` base is cheap and preserves the contract.
- **The container is the seam.** Tests substitute via the container; nothing else.

---

## Detection hints (consumed by `pr-self-review`)

| Rule     | Hint |
|----------|------|
| MUST.1   | List files registering Fastify routes: `grep -rlE '\bfastify\.(get\|post\|put\|patch\|delete)\(' server/src`. For each, `grep -nE "from ['\"].*\badapters/" $file` → any hit is a violation. |
| MUST.2   | `grep -rE "from ['\"](octokit\|simple-git\|node:fs(/promises)?)\b" server/src/modules` and `grep -rE '\bfetch\(' server/src/modules`. Any hit is a violation. |
| MUST.3   | `grep -rnE '\bthrow new Error\(' server/src/modules` plus the same over Fastify route files identified for MUST.1. Any hit is a violation. |
| MUST.4   | For every pair of module folders `(X, Y)` under `server/src/modules/`, `grep -rE "from ['\"].*\bmodules/${X}/" server/src/modules/${Y}/` for `X ≠ Y ≠ _shared`. Any hit is a violation. |
| MUST.5   | For every pair of adapter folders `(A, B)` under `server/src/adapters/`, `grep -rE "from ['\"].*\badapters/${A}/" server/src/adapters/${B}/` for `A ≠ B`. Any hit is a violation. |
| MUST.6   | For each route declaration found in MUST.1, manual review: does the declaration include a `schema:` property covering body/query/params it reads? |
| SHOULD.7 | `grep -rnE '\bnew \w+Adapter\(' server/src` → any hit outside `server/src/platform/container.ts` is an advisory. |
| SHOULD.8 | `grep -rE "from ['\"].*\badapters/mocks" server/src` → any hit in a non-test file is an advisory. |
| SHOULD.9 | Manual review: a module-level `const x = container.<service>()` outside a function/handler body. |
| SHOULD.10| `find server/src -name '*.test.ts' -not -name '*.it.test.ts' | xargs grep -lE "(testcontainers\|test/helpers/pg)"` → any hit is an advisory. |

---

## When to invoke

Use this skill when editing or reviewing any file under `server/src/`. The `pr-self-review` workflow loads it for the server-side review pass.

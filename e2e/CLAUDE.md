# e2e/ — end-to-end browser flows

## Stack
- agent-browser (Rust + CDP) driving real Chrome
- Declarative JSON spec files — no Playwright/Cypress
- **No LLM calls.** Stack is seeded; flows are deterministic.

## Commands
- `./scripts/e2e.sh`       — hermetic full-stack e2e (run from project root)
- `npm test` (from `e2e/`) — same as above
- `npm run e2e:hermetic`   — explicit hermetic mode

Requires Docker (ephemeral Postgres, API, web).

## Where things live (map only)
- `specs/*.flow.json`   one spec per user-visible flow (boot, repos, agents, findings, diff, onboarding, settings)
- `lib/`                runner glue
- `run.ts`              entry point
- `agent-browser.json`  driver config

## Non-default conventions
- One spec per user flow, numbered (`01-`, `02-`, …) in display order.
- Specs are declarative JSON — no embedded code. If a flow needs logic, fix the test surface in `client/` or `server/`, don't add code here.
- The stack must start clean every run (no leftover containers, no shared state with dev DB).

## Gotchas
- LLM is mocked at the server level for e2e — these flows verify the UI contract, not review quality.
- A failing e2e is almost always a UX/contract change. Update the spec deliberately; don't paper over it.
- The CI job `e2e-web.yml` brings up its own stack; don't depend on `scripts/dev.sh` state.

## Do-not-touch zones
- `specs/*.flow.json` — change only with intentional UX update. These are the user-flow contract.

## More
- [README.md](README.md)
- [docs/](docs/), [INSIGHTS.md](INSIGHTS.md)
- Root: [../CLAUDE.md](../CLAUDE.md)

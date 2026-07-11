---
name: sse-patterns
description: Repo-specific SSE conventions and gotchas. Use when editing or reviewing any file that emits, consumes, or tests Server-Sent Events in DevDigest — namely `server/src/platform/sse.ts`, `server/src/platform/run-logger.ts`, `server/src/vendor/shared/contracts/trace.ts`, any `server/src/modules/*/routes.ts` that emits SSE, or any `client/src/lib/hooks/*.ts` that uses `EventSource`. Codifies the `done`-ordering race, the `runBus.complete()` method-name gotcha, the `RunEventKind` exhaustiveness coupling, and the `.inject()`-vs-real-socket testing trap — all bought and paid for in prior incidents recorded in `INSIGHTS.md`.
---

# SSE Patterns

Server-Sent Events (SSE) in this repo run over `fastify-sse-v2` (registered in `server/src/app.ts:5`), backed by a single in-process `RunBus` pub/sub at `server/src/platform/sse.ts`. Both existing SSE routes (reviews, conventions) use the same pattern. This skill codifies the rules learned from prior incidents so future SSE work doesn't re-derive them.

Companion to `server/CLAUDE.md`.

## Severity

- **MUST** — a hard rule. Violations block merge. Enforced by `/pr-self-review` when detection-hints match.
- **SHOULD** — a strong recommendation. Advisory, but expect a comment.

## Rules

### MUST.1 — Emit terminal `done` from the layer that owns the side-effect commit

The layer that produces the *data* is NOT necessarily the layer that persists it. If the producer emits `'done'` before the persistence layer has committed the change, any UI that refetches on `'done'` will race the commit and read stale/empty state.

This is the flagship bug in this repo. From `server/INSIGHTS.md` (2026-06-24):

> `extractor.ts` emitted `'done'` and then returned `verified`. `service.runExtraction` ran `deleteByRepo` BEFORE the extractor, then `insertMany` AFTER the extractor returned — i.e. AFTER `'done'` had already left for the browser. The UI hook `useExtractConventions` listened for `'done'` and called `qc.invalidateQueries` immediately, which fired `GET /conventions`. That GET raced `insertMany`. When the GET won, it hit the table during the brief window after delete-but-before-insert and returned `[]`.

**Rule:** the `'done'` event MUST be emitted by the service layer, immediately after the transactional side effect (`insertMany`, or whatever the commit is) returns. Not by a deep helper. Not by the extractor.

**Why:** any SSE background job that (a) wipes-then-writes, (b) emits a "finished" event from a deep layer, (c) has a UI that refetches on that event, will race the same way.

**Red flag:** a function that returns data AND emits `'done'` in the same body, when a caller further up the stack still has DB writes to do with that data.

### MUST.2 — Use `runBus.complete(runId)` for the done signal, never `done()` or `markDone()`

From root `INSIGHTS.md` (2026-06-23): the method name is not guessable from consumer side.

**Rule:** to signal a run is finished, call `container.runBus.complete(runId)`. The class at `server/src/platform/sse.ts:76` is authoritative.

**Why:** plan docs and prior implementations have guessed `done()` / `markDone()`, which don't exist. Silent no-op, then the SSE stream never closes and the UI hangs.

**Red flag:** any call like `runBus.done(...)`, `runBus.markDone(...)`, `runBus.finish(...)`.

### MUST.3 — Extending `RunEventKind` requires updating the `LEVEL` map in `run-logger.ts`

The `RunEventKind` zod enum at `server/src/vendor/shared/contracts/trace.ts:9` is the source of truth for event kinds. The `LEVEL: Record<RunEventKind, keyof PinoLike>` exhaustive map at `server/src/platform/run-logger.ts:29` MUST cover every enum member — TypeScript enforces this at typecheck time.

**Rule:** when adding a new `RunEventKind`, add a matching entry to `LEVEL` in the same commit.

**Why:** the coupling is invisible unless you happen to run typecheck. From root `INSIGHTS.md` (2026-06-23): "extending the `RunEventKind` enum in `trace.ts` ... What worked: also updating the `LEVEL` map in `run-logger.ts` — an exhaustive `Record<RunEventKind, keyof PinoLike>` that TypeScript enforces at compile time."

**Red flag:** a diff that adds a value to `RunEventKind` without touching `run-logger.ts` in the same PR.

### MUST.4 — Terminal event is emitted AFTER all data events, immediately before stream close

There is no formal SSE spec for end-of-stream signaling — it's an application-level convention. Anthropic's Messages API uses a typed `message_stop` event; OpenAI uses a `data: [DONE]\n\n` sentinel. In both, the terminal marker is the LAST payload written before the HTTP connection is closed. Never before pending data events.

**Rule:** in any producer route or bus emitter, ensure the terminal event (`'done'`, `runBus.complete(runId)`, or the equivalent) is the last write before the connection closes.

**Why:** clients race on the terminal event — most consumers unsubscribe or fire cleanup on it. Emitting terminal before data means the client tears down before hearing the payload.

**Red flag:** any code path where `complete()` or `emit('done')` is called before an `await` on a data-emit or a DB write that produces a data-emit.

### MUST.5 — Do NOT use `reply.raw` or `reply.hijack()` for new SSE routes

Fastify's own Reply docs: *"the use of `Reply.raw` functions is at your own risk as you are skipping all the Fastify logic of handling the HTTP response."* Liran Tal's engineering post goes further: hijacking bypasses `onRequest` hooks, CORS, and auth plugins like `@fastify/jwt`.

**Rule:** all SSE routes MUST use `reply.sse()` from the `fastify-sse-v2` plugin (already registered in `server/src/app.ts:5`). Both existing SSE routes (`server/src/modules/reviews/routes.ts:55`, `server/src/modules/conventions/routes.ts:53`) already use this — copy from them.

**Why:** hijacked responses silently skip auth, hooks, and CORS — a security regression by omission.

**Red flag:** any occurrence of `reply.raw` or `reply.hijack` in a route file.

### SHOULD.6 — Use `RunBus.onDone(runId, listener)` for late-subscriber safety

`RunBus.onDone` at `server/src/platform/sse.ts:90-100` fires the listener immediately (via `queueMicrotask`) if `this.completed.has(runId)`. This prevents client hangs when subscription happens after the producer has already emitted `done`.

**Rule:** clients or downstream consumers subscribing to a run they might have missed the `done` event for SHOULD use `onDone`, not a raw event listener.

**Why:** late subscribers to a completed run otherwise wait forever for an event that already fired.

**Red flag:** a subscriber listening for `'done'` on `runBus` without checking `onDone` for already-completed runs.

### SHOULD.7 — Do NOT rely on `fastify.inject()` for real SSE integration tests

The one existing SSE test at `server/test/reviews.it.test.ts:266` (`'SSE: /runs/:id/events streams events and completes'`) uses `app.inject()` + a `payload` string-contains assertion. This works ONLY because `RunBus` replays its buffer to late subscribers AND the run is synchronous in-test. For real streaming assertions (async producer, ordering, timing), `.inject()` doesn't exercise a real socket — it captures the buffered payload.

**Rule:** for tests that need to verify ORDER of events, TIMING, or ASYNC producer behavior, use `server.listen(0)` + a real HTTP client (`fetch`/undici) + assertions on the chunk sequence. Keep `.inject()` for the smoke-test case only.

**Why:** the existing test passes because the producer completes before the buffer is captured. It would NOT catch a race like the one described in MUST.1.

**Red flag:** any new `*.it.test.ts` that uses `app.inject` with a URL containing `event-stream` or `/events/`.

### SHOULD.8 — Any new SSE route needs a companion test

The conventions extraction route at `server/src/modules/conventions/routes.ts:43` (`GET /repos/:id/conventions/events/:scanId`) currently has NO test. This is an existing gap. Any new SSE route must not add to it.

**Rule:** a new SSE route ships with at least one test verifying the happy path (subscribe → receive expected events → see `done` → connection closes).

**Why:** SSE bugs are hard to spot from static review — the `done`-ordering race hid behind three passing scans before users reported empty state.

**Red flag:** a diff that adds a new `reply.sse(...)` block without a matching test file update in the same PR.

### SHOULD.9 — When adding a new `RunEventKind`, plan for typecheck exhaustiveness first

Before adding the enum member, search for every exhaustive map that must be updated:

```
grep -rnE 'Record<RunEventKind' server/
```

Currently one hit (the `LEVEL` map). Treat the search as the durable habit — don't hardcode "there is one map to update," because a future refactor may add another.

**Why:** the coupling is enforced by typecheck, but ONLY at typecheck time — running tests won't catch it. Plan the change to keep both files in sync.

**Red flag:** a diff adding to `RunEventKind` without a corresponding diff to files matching `Record<RunEventKind`.

### SHOULD.10 — Emit heartbeat comments at ~15s intervals for long-idle streams

SSE proxies and load balancers (nginx, Cloudflare) will disconnect idle connections. Standard mitigation: emit a comment line (`: keep-alive\n\n` or `:\n\n`) at ~15s intervals. `fastify-sse-v2` provides helpers for this; check its docs for the current API.

**Rule:** if a stream can be idle for >30s, add heartbeat comments.

**Why:** silent disconnects are among the hardest SSE bugs to debug — the client sees "connection closed" with no server-side error.

**Red flag:** a long-running SSE route with no timeout config and no heartbeat.

### SHOULD.11 — Backend SSE responses must set `X-Accel-Buffering: no`

nginx's `proxy_buffering` is on by default and will hold the response body before forwarding — killing SSE.

**Rule:** manual/raw SSE responses MUST set `X-Accel-Buffering: no`. `fastify-sse-v2` handles this via its reply helper automatically (verify current version behavior if in doubt), so routes using `reply.sse()` are covered.

**Why:** silent staleness — the client eventually receives everything, but in a single flush at connection close, defeating the point of SSE.

**Red flag:** a manual streaming response that doesn't set `X-Accel-Buffering: no` and doesn't use `reply.sse()`.

## Principles & rationale

- **Ordering is per-connection by protocol, but Node's async scheduling can reorder writes in-process** before they hit the wire. The `await` boundary matters. If you emit event A, then start (but don't await) an async op, then emit event B, B can land on the wire before A's side effect completes.
- **No LLM token-streaming-to-SSE pattern exists in this repo today.** The `onEvent` callback in `reviewer-core/src/review/run.ts` is a discrete-event callback, not a token stream. LLM calls in `server/src/modules/reviews/run-executor.ts` are awaited synchronously; progress is reported via `RunLogger` events. Implementers should NOT assume a token-stream pattern exists — if you need one, that's new work.
- **`server/src/modules/reviews/run-executor.ts` uses `runBus.complete(runId)` correctly** at three sites (lines 91, 299, 323). But that file is flagged by the source `INSIGHTS.md` entry as "worth a future audit for the same shape" (wipe-then-write races) — meaning the method-name is right, but the *emission ordering relative to persistence* has not been formally audited. Any diff touching that file should re-check MUST.1 personally.
- **`RunBus` replays its buffer to late subscribers** — a subscribe-after-emit sees the historical events. This is why the existing `.inject()`-based test works; it's also what makes `onDone` safe to call on already-completed runs.

## Detection hints (consumed by `pr-self-review`)

| Rule | Hint |
|---|---|
| MUST.2 | `grep -rnE 'runBus\.done\(\|runBus\.markDone\(\|runBus\.finish\(' server/src/` |
| MUST.5 | `grep -rnE 'reply\.raw\|reply\.hijack' server/src/` |
| MUST.1 (heuristic) | `grep -rnE "emit\\(.*['\"]done['\"]\|complete\\(.*runId\\)" server/src/modules/` |
| SHOULD.7 | `grep -rnE 'inject.*event-stream' server/test/` |
| MUST.3 (heuristic) | `git diff --name-only HEAD | grep -E '(trace\.ts|run-logger\.ts)'` — if only one hits, flag it |

## When to invoke

This skill applies to any diff touching:

- `server/src/platform/sse.ts` (the `RunBus` class).
- `server/src/platform/run-logger.ts` (the `LEVEL` map + logging bridge).
- `server/src/vendor/shared/contracts/trace.ts` (`RunEventKind` enum + related types).
- Any `server/src/modules/*/routes.ts` that emits SSE (currently: reviews, conventions).
- Any `client/src/lib/hooks/*.ts` that uses `EventSource` (currently: `conventions.ts`, `reviews.ts`).
- Any new backend file that imports from `fastify-sse-v2` or creates a raw event-stream response.

`/pr-self-review` should load this skill when the diff matches any of the above paths.

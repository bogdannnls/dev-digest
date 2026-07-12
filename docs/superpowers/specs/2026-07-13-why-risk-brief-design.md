# Why + Risk Brief — design

- **Status:** approved design (brainstorming output); input to `spec-creator`
- **Date:** 2026-07-13
- **Branch:** `feat/l05-why-risk-brief`
- **Modules touched:** `server/` (new `overview/brief-synth`), `client/` (Overview tab), shared contracts, one migration
- **Supersedes/retires:** the dormant `PrBrief` composite in `shared/contracts/brief.ts`

## 1. Problem & context

The PR Overview tab already renders most of the target mockup from **already-shipped**
pieces. This feature adds the one genuinely missing piece — a synthesized top-of-page
narrative plus a prioritized **"Review focus — read these first"** list — as a thin
second LLM pass over existing artifacts.

What already exists (do **not** rebuild):

| Mockup region | Backed by | Status |
|---|---|---|
| Top verdict card (`Request changes · 6 findings · 2 blockers · 61 · $0.014`) | `PrOverviewBrief` → `GET /pulls/:id/overview/brief` (pure aggregation, no LLM) | shipped |
| INTENT panel (quote, In/Out of scope) | Intent layer `PrIntentDto.goal/inScope/outOfScope` → `GET …/overview/intent` (LLM, cached, SSE, refresh, staleness) | shipped |
| RISK AREAS (auth / dep / round-trip) | Intent's `riskAreas[]` (icon+label, max 3) | shipped |
| BLAST RADIUS (symbols/callers/endpoints/cron) | L04 `BlastRadius` | shipped |
| Files changed — Smart order | L03 `SmartDiff` | shipped |
| **REVIEW FOCUS — READ THESE FIRST** | `review_focus` — **zero usages** | **net-new** |
| Unified synthesized brief `{what, why, riskLevel, risks[], reviewFocus[]}` | — | **net-new** |

## 2. Goals

- Produce a synthesized `{what, why, riskLevel, risks[], reviewFocus[]}` brief for a PR
  from pre-computed inputs, in **one** structured LLM call.
- The `reviewFocus[]` list is line-precise and **grounded** (real findings), matching the mockup.
- Cost + tokens are tracked and displayed, consistent with other LLM cards.
- Read-through cache with staleness detection and a manual regenerate action.

## 3. Non-goals (YAGNI)

- No re-computation of intent, blast radius, findings, or smart-diff — the Brief **composes** them.
- No feeding of raw diff bodies to the model (explicit constraint).
- No new review/analysis — findings come from the review that already ran.
- No semantic spec retrieval — "relevant specs" = the reviewer agent's attached-context set (deterministic).
- No auto-regeneration cascade (recomputing intent/blast on demand).

## 4. Inputs & provenance

The synth call consumes only pre-computed data. Provenance annotations per the brief:

| Input | Source | Provenance |
|---|---|---|
| intent (goal / inScope / outOfScope / riskAreas) | `pr_intent` row | `[reused]` |
| blast summary (symbols, callers, endpoints, crons) | L04 BlastRadius | `[reused]` |
| findings (id, file, startLine, endLine, severity, title, rationale) | `findings` rows for the latest review | `[reused]` |
| diff stats (core/wiring/boilerplate counts, +/−) | L03 SmartDiff groups | `[reused]` |
| linked issue | already inside `intent.references` | `[reused]` |
| attached specs (paths/titles only, **not** bodies) | reviewer agent `attachedContextPaths` via `ContextService` | `[reused]` |
| the synthesized brief | one structured LLM call | `[new call]` |
| `riskLevel` floor | blocker/critical finding count | `[deterministic]` |

**No diff bodies** are sent. Findings already carry grounded `file`/`startLine` from when
the review ran (they passed `platform/grounding.ts`).

## 5. Data flow

```
pr_intent ─┐
blast ─────┤
findings ──┼─► assembleBriefInput() ─► one structured LLM call ─► PrWhyRiskBrief ─► cache (pr_brief)
diff-stats ┤        (no diff bodies)         (records agent_run + run_cost)
specs ─────┘
```

## 6. The grounding-safe trick (key decision)

`reviewFocus[]` items reference findings **by id**; the model never emits a file:line:

```ts
reviewFocus: Array<{ findingId: string; note: string }>   // note = "why read this first"
```

The client resolves `file`/`line`/`title`/`severity` from the referenced finding.
Because the model only picks IDs from a provided list, it is **structurally impossible**
to trip the citation gate, and output tokens stay minimal. The spec MUST require that any
`findingId` not present in the input finding set is dropped (defensive validation).

## 7. Contract (`shared/contracts/brief-synth.ts`)

New name to avoid clashing with the aggregation `PrOverviewBrief` and the dormant `PrBrief`.

```ts
PrWhyRiskBrief = {
  what: string;                                 // one sentence: what the PR does
  why: string;                                  // one sentence: why (intent.goal / linked issue)
  riskLevel: RiskSeverity;                       // reuse existing enum: 'high' | 'medium' | 'low'
  risks: RiskArea[];                             // structural areas; each may carry a grounded fileRef
  reviewFocus: { findingId: string; note: string }[];
  model: string;
  cost: { tokensIn: number; tokensOut: number; usd: number };
  computedAt: string;
  basedOn: { headSha: string; reviewId: string; intentComputedAt: string };
}

PrWhyRiskBriefResponse =
  | { status: 'ready'; data: PrWhyRiskBrief }
  | { status: 'ready-stale'; data: PrWhyRiskBrief; staleReasons: ('head_sha' | 'new_review' | 'intent')[] }
  | { status: 'not_ready'; missing: ('intent' | 'review')[] }
  | { status: 'computing'; runId: string }
  | { status: 'error'; message: string }
```

`RiskArea` reuses/extends the shipped `intent.riskAreas` shape (`{ icon, label }`) with an
optional grounded `fileRef` sourced from findings/blast — never invented.

## 8. Endpoints (mirror the Intent layer)

```
GET  /pulls/:id/overview/brief-synth          → PrWhyRiskBriefResponse (read-through cache)
POST /pulls/:id/overview/brief-synth/refresh  → 202 { runId } (rate-limited, same limits as intent)
GET  /pulls/:id/overview/brief-synth/stream    → SSE RunEvent stream for the run
```

Rationale for GET+POST/refresh over a bare `POST` (approved deviation): reuses the shipped
SSE / react-query / cost-tracking machinery, so the `$0.014 · 8.2K→1.3K` line comes for free,
and the client hook clones `useOverviewIntent`.

## 9. Caching & staleness

- Cache keyed by `pr_id` in a new `pr_brief` table (mirrors `pr_intent`).
- `basedOn` records `headSha`, latest `reviewId`, and `intentComputedAt`.
- On GET, compare stored vs current → `ready` or `ready-stale(+reasons)`. Stale reasons:
  `head_sha` changed, a `new_review` completed since, or `intent` recomputed.
- Manual regenerate = `POST …/refresh`. No background recompute.

## 10. Decisions (approved)

1. **Findings are an input**; `reviewFocus` = ranked finding IDs. Only gate-safe, cheapest way.
2. `riskLevel` is LLM-assigned but **floored** deterministically: any `blocker`/`critical`
   finding ⇒ `riskLevel` ≥ `high`. Prevents under-rating.
3. `GET` + `POST …/refresh` (not bare `POST`) — reuse + cost tracking.
4. Specs passed as **paths/titles**, not bodies — scope already lives in `intent`.
5. `not_ready(missing)` state when intent or a review is absent — no cascade orchestration.
6. Retire the dormant `PrBrief` composite (unwired, superseded).

## 11. Cost tracking

The refresh executes as a recorded `agent_run` with a `run_cost` row (same path the Intent
layer uses), so the Overview aggregation and the card can display tokens/USD.

## 12. Client

- `PrWhyRiskBriefCard` (or extend the existing brief card region): risk-level color, the
  what/why narrative, and the "Review focus — read these first" list linking each item to its
  file:line (resolved from the finding).
- New react-query hook `useOverviewBriefSynth` cloned from `useOverviewIntent` (SSE progress + refresh).

## 13. Testing

- `reviewer-core`/server: pure `assembleBriefInput()` unit tests; `riskLevel` floor unit tests;
  `findingId` validation (unknown ids dropped).
- Integration (`*.it.test.ts`): route returns `not_ready` without intent/review; `ready` after;
  `ready-stale` after head_sha / new review; refresh records a run+cost.
- Client: card renders each state; focus links resolve to finding file:line.

## 14. Open questions for `spec-creator`

- Exact rate-limit numbers for `refresh` (reuse intent's 1/min/PR, 30/hr/workspace?).
- Whether `risks[]` reuses `intent.riskAreas` verbatim or is re-derived in the synth call
  (leaning: reuse + attach grounded fileRef; confirm in EARS ACs).
- Migration column set for `pr_brief` (mirror `pr_intent` minus intent-specific fields).
- Which `Feature-Models` id drives this call (`risk_brief`, or a new `review_focus` id?).

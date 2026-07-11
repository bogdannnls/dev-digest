import type { Container } from '../../platform/container.js';
import type { Provider, Review, RunTrace, UnifiedDiff } from '@devdigest/shared';
import { reviewPullRequest, countBlockers } from '@devdigest/reviewer-core';
import { RunLogger } from '../../platform/run-logger.js';
import * as schema from '../../db/schema.js';
import type { AgentRow } from '../../db/rows.js';
import type { ReviewRepository, FindingRow, PullRow, ReviewRow } from './repository.js';
import { REVIEW_STRATEGY } from './constants.js';
import { taskLine } from './helpers.js';
import { loadDiff } from './diff-loader.js';

/** Thrown by a run when the user cancels it mid-flight (between map files). */
export class RunCancelledError extends Error {
  constructor() {
    super('Run cancelled');
    this.name = 'RunCancelledError';
  }
}

/** Minimal structured logger (pino-compatible: (obj, msg)) for runtime logs. */
export type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
};

// A reduced "Review per file" — same schema as Review (the model returns a small
// Review per file; we merge findings + take the worst verdict / mean score).
export type RunOutcome = {
  review: ReviewRow;
  findings: FindingRow[];
  grounding: string;
  raw: Review;
};

/**
 * Owns the background execution of queued agent runs (extracted from
 * ReviewService; behaviour unchanged). Loads the diff + intent once, then
 * map-reduces each agent, streaming events over the runBus and persisting each
 * review. Per-agent failures are isolated.
 */
export class ReviewRunExecutor {
  constructor(
    private container: Container,
    private repo: ReviewRepository,
    private agents: Container['agentsRepo'],
  ) {}

  /**
   * Background execution of the queued agent runs (NOT awaited by the route).
   * Loads the diff + intent once, then map-reduces each agent, streaming events
   * over the runBus and persisting each review. Per-agent failures are isolated.
   */
  async executeRuns(
    workspaceId: string,
    pull: PullRow,
    repo: typeof schema.repos.$inferSelect,
    jobs: { agent: AgentRow; runId: string }[],
    logger?: Logger,
  ): Promise<void> {
    // ONE logger fanned out over every queued run: shared pre-work (diff +
    // intent) is streamed into each target agent's Live Log and persisted into
    // each run's trace. Per-agent work below narrows it to a single run.
    const runLog = new RunLogger(
      this.container.runBus,
      jobs.map((j) => j.runId),
      logger,
      { prId: pull.id },
    );

    // Pre-work failure (e.g. diff load) fails EVERY queued run. The error was
    // already emitted via runLog (fanned out → in each run's buffer); here we
    // mark the rows failed and persist the buffered log so it survives a reload.
    const failAll = async (msg: string) => {
      for (const { runId, agent } of jobs) {
        await this.repo
          .completeAgentRun(runId, {
            status: 'failed',
            durationMs: 0,
            tokensIn: 0,
            tokensOut: 0,
            findingsCount: 0,
            grounding: '0/0 passed',
            error: msg,
          })
          .catch(() => undefined);
        await this.repo
          .saveRunTrace(runId, this.traceFromBuffer(runId, pull, agent, '0/0 passed'))
          .catch(() => undefined);
        this.container.runBus.complete(runId);
      }
    };

    let diff: UnifiedDiff;
    try {
      diff = await runLog.step('Loading PR diff', () => loadDiff(this.container, this.repo, workspaceId, pull, repo), {
        kind: 'tool',
      });
    } catch (err) {
      runLog.error(`Failed to load PR diff: ${(err as Error).message}`);
      await failAll(`Failed to load PR diff: ${(err as Error).message}`);
      return;
    }
    runLog.info(`Diff ready — ${diff.files.length} changed file(s); starting ${jobs.length} agent run(s)`);

    for (const { agent, runId } of jobs) {
      const agentStart = Date.now();
      logger?.info(
        { runId, agent: agent.name, provider: agent.provider, model: agent.model, prId: pull.id },
        `review: agent "${agent.name}" started (${agent.provider}/${agent.model})`,
      );
      try {
        const outcome = await this.runOneAgent(workspaceId, pull, repo, diff, agent, runId, runLog);
        logger?.info(
          {
            runId,
            agent: agent.name,
            findings: outcome.findings.length,
            grounding: outcome.grounding,
            durationMs: Date.now() - agentStart,
          },
          `review: agent "${agent.name}" done — ${outcome.findings.length} finding(s)`,
        );
      } catch (err) {
        // runOneAgent already persisted the failure/cancel (status + error +
        // trace) and completed the bus; here we only log at the run level.
        const cancelled = err instanceof RunCancelledError;
        logger?.[cancelled ? 'info' : 'error'](
          { runId, agent: agent.name, err: (err as Error).message, durationMs: Date.now() - agentStart },
          `review: agent "${agent.name}" ${cancelled ? 'cancelled' : 'failed'}`,
        );
      }
    }
  }

  /** Execute a single agent's review against a PR, streaming progress. */
  private async runOneAgent(
    workspaceId: string,
    pull: PullRow,
    repo: typeof schema.repos.$inferSelect,
    diff: UnifiedDiff,
    agent: AgentRow,
    runId: string,
    parentLog: RunLogger,
  ): Promise<RunOutcome> {
    const start = Date.now();
    // Narrow the fanned-out pre-work logger to THIS run; the shared diff/intent
    // events are already in this run's buffer, so the persisted trace below
    // (built from the buffer) includes them too.
    const runLog = parentLog.forRun(runId, { agent: agent.name });

    runLog.info(`Starting review with agent "${agent.name}" (${agent.provider}/${agent.model})`);

    // L05 T4 — populated by `buildSpecsDigest` inside the try block below.
    // Hoisted above the try so the failure path (catch, below) can still
    // report what was actually read if a LATER step fails (e.g. the LLM call
    // itself) — while staying the empty default when the pre-flight check
    // itself is what failed (nothing was read yet).
    let specsRead: string[] = [];
    let specsTokens: number[] = [];

    try {
      // Resolve the agent's LLM provider. (container.llm throws if the provider
      // key is missing — caught below and persisted as a failed run.)
      const llm = await runLog.step(
        `Resolving ${agent.provider} provider`,
        () => this.container.llm(agent.provider as Provider),
        { kind: 'tool' },
      );

      // Per-agent repo-intel toggle (Agent editor). When an agent opts out we
      // skip all enrichment entirely so its prompt is identical to the
      // repo-intel-off baseline — independent of the global REPO_INTEL_ENABLED
      // flag, which still gates the facade internally.
      const repoIntelOn = agent.repoIntel !== false;
      if (!repoIntelOn) runLog.info('Repo intel disabled for this agent — skipping context enrichment');

      // T1.3 — callers-in-prompt. Best-effort: when repo-intel is off the facade
      // returns []; we omit the section and behavior is identical to the
      // pre-T1.3 prompt (acceptance #10).
      const callersDigest = repoIntelOn
        ? await this.buildCallersDigest(pull.repoId, diff, runLog)
        : undefined;

      // T3 — repo skeleton + "changed files are top-5%" framing. Both best-
      // effort: when repo-intel is off / unindexed the facade degrades and the
      // prompt is identical to the pre-T3 shape.
      const repoMap = repoIntelOn ? await this.buildRepoMapDigest(pull.repoId, runLog) : undefined;
      const rankNote = repoIntelOn ? await this.buildRankNote(pull.repoId, diff, runLog) : '';

      const task = taskLine(pull) + rankNote;

      // Spec D — pass enabled linked-skill bodies to the review engine so the
      // prompt includes the agent's configured rubrics/rules. Empty when the
      // agent has no enabled links; assemblePrompt omits the section in that case
      // (prompt identical to the pre-Spec-D shape — no regression).
      const skillBodies = await this.agents.enabledSkillBodiesForAgent(agent.id);
      if (skillBodies.length > 0) {
        runLog.info(`Loaded ${skillBodies.length} skill body/bodies for agent "${agent.name}"`);
      }

      // L05 T4 — Project context: the effective attached-document set (agent's
      // own paths + enabled linked skills' paths, deduped), pre-flight
      // re-verified against a FRESH discovery pass, then read + tokenized.
      // Fail-CLOSED (unlike the repo-intel digests above): any offending path
      // throws here, before any file read and before the LLM call below.
      // Deliberately NOT gated by `repoIntelOn` (unlike buildCallersDigest/
      // buildRepoMapDigest/buildRankNote above): attached project context is
      // an explicit per-agent/per-skill user opt-in, orthogonal to the
      // repo-intel auto-enrichment toggle — "repo-intel off" alone does not
      // imply "identical baseline prompt" once documents are attached.
      const specsDigest = await this.buildSpecsDigest(agent, repo, workspaceId, runLog);
      specsRead = specsDigest.specsRead;
      specsTokens = specsDigest.tokens;

      // ---- Engine: assemble → single-pass → grounding -----------------------
      // The pure review pipeline lives in @devdigest/reviewer-core (shared with
      // the CI runner). The service owns only I/O: repo-intel context resolution
      // above, and persistence + observability below.
      const outcome = await reviewPullRequest({
        systemPrompt: agent.systemPrompt,
        model: agent.model,
        diff,
        llm,
        // Per-agent review strategy (configured in the Agent editor); falls back
        // to the studio default. single-pass = whole diff in one call.
        strategy: agent.strategy ?? REVIEW_STRATEGY,
        // Spec D — inject resolved skill bodies (omit the key when empty so the
        // prompt assembly is identical to today for agents with no linked skills).
        ...(skillBodies.length > 0 ? { skills: skillBodies } : {}),
        // T1.3 — pass the callers digest only when we built one. assemblePrompt
        // omits the section when this is empty/undefined.
        ...(callersDigest ? { callers: callersDigest } : {}),
        // T3 — repo skeleton, same omit-when-empty contract.
        ...(repoMap ? { repoMap } : {}),
        // L05 T4 — Project context: attached specs/docs/insights content, read
        // fresh above. Omitted when the effective set is empty (AC-24) — the
        // prompt is then identical to today's always-empty-specs shape.
        ...(specsDigest.specs.length > 0 ? { specs: specsDigest.specs } : {}),
        // PR author's description/body — untrusted; assemblePrompt wraps +
        // truncates it. Omitted when the PR has no body.
        ...(pull.body ? { prDescription: pull.body } : {}),
        task,
        sessionId: `${repo.owner}/${repo.name}#${pull.number}:${agent.name}`,
        onEvent: (e) => runLog.event(e.kind, e.msg, e.data),
        checkCancelled: () => {
          if (this.container.runBus.isCancelled(runId)) throw new RunCancelledError();
        },
      });
      const { tokensIn, tokensOut, grounding } = outcome;

      const keptFindings = outcome.review.findings;

      // ---- Persist review + findings ----------------------------------------
      const review = await this.repo.insertReview({
        workspaceId,
        prId: pull.id,
        agentId: agent.id,
        runId,
        kind: 'review',
        verdict: outcome.review.verdict,
        summary: outcome.review.summary,
        score: outcome.review.score,
        model: agent.model,
      });
      const findingRows = await this.repo.insertFindings(review.id, keptFindings);
      runLog.result(`Persisted review ${review.id} with ${findingRows.length} finding(s)`);

      // Mark the commit this review ran against so the PR list can tell
      // reviewed / needs-review (head moved) / stale apart.
      await this.repo.markReviewed(pull.id, pull.headSha);

      const durationMs = Date.now() - start;

      // Deterministic blocker count (severity ≥ the agent's gate) — the signal
      // the timeline colors on, NOT the model's self-reported verdict.
      const blockers = countBlockers(keptFindings, agent.ciFailOn);

      // ---- Observability: agent_runs + ONE run_traces document --------------
      await this.repo.completeAgentRun(runId, {
        status: 'done',
        durationMs,
        tokensIn,
        tokensOut,
        findingsCount: findingRows.length,
        grounding,
        score: outcome.review.score,
        blockers,
        error: null,
      });

      const trace: RunTrace = {
        config: {
          agent: agent.name,
          version: String(agent.version),
          provider: agent.provider,
          model: agent.model,
          pr: pull.number,
          source: 'local',
        },
        stats: {
          duration_ms: durationMs,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          findings: findingRows.length,
          grounding,
        },
        prompt_assembly: outcome.assembly,
        tool_calls: outcome.chunks.map((c) => ({
          tool: 'review_file',
          args: c.label,
          meta: outcome.mode,
          ms: Math.round(durationMs / Math.max(outcome.chunks.length, 1)),
        })),
        raw_output: outcome.raw,
        memory_pulled: [],
        // L05 T4 — AC-25/26: paths actually read, in effective-set order, and
        // their per-document token-count estimate (index-aligned with
        // `specs_read`).
        specs_read: specsRead,
        specs_tokens: specsTokens,
        // Persisted log = the run's FULL event buffer (incl. shared pre-work:
        // diff load + intent), not just events recorded inside this method.
        log: runLog.logFor(runId),
      };
      runLog.info('Run complete; trace persisted');
      await this.repo.saveRunTrace(runId, trace);
      this.container.runBus.complete(runId);

      return { review, findings: findingRows, grounding, raw: outcome.review };
    } catch (err) {
      // Failure/cancel: persist status + the error text + the log-so-far so the
      // run (and WHY it failed) is visible on the UI after a reload.
      const cancelled = err instanceof RunCancelledError;
      const status = cancelled ? 'cancelled' : 'failed';
      const msg = cancelled ? 'Cancelled by user' : (err as Error).message;
      runLog.error(cancelled ? 'Run cancelled by user' : `Run failed: ${msg}`);
      await this.repo
        .completeAgentRun(runId, {
          status,
          durationMs: Date.now() - start,
          tokensIn: 0,
          tokensOut: 0,
          findingsCount: 0,
          grounding: '0/0 passed',
          error: msg,
        })
        .catch(() => undefined);
      await this.repo
        .saveRunTrace(
          runId,
          this.traceFromBuffer(runId, pull, agent, '0/0 passed', Date.now() - start, specsRead, specsTokens),
        )
        .catch(() => undefined);
      this.container.runBus.complete(runId);
      throw err;
    }
  }

  /**
   * Build a compact "Callers of changed symbols" digest for the prompt.
   *
   * Returns `undefined` when nothing should be added (flag off, no callers
   * found, or repo-intel errors) — `reviewPullRequest` omits the section in
   * that case (acceptance #10: flag off → identical prompt).
   *
   * Compact format: one bullet per caller, grouped by file. Trimmed (limit 10
   * rows per `getCallerSignatures` call) so the section stays under ~600
   * tokens even on heavy PRs.
   */
  private async buildCallersDigest(
    repoId: string,
    diff: UnifiedDiff,
    runLog: RunLogger,
  ): Promise<string | undefined> {
    const changedFiles = diff.files.map((f) => f.path);
    if (changedFiles.length === 0) return undefined;
    let rows;
    try {
      rows = await this.container.repoIntel.getCallerSignatures(repoId, changedFiles, 10);
    } catch (err) {
      // Never let an enrichment break the run — surface only as a Live Log info.
      runLog.info(`callers digest: repoIntel failed — ${(err as Error).message}`);
      return undefined;
    }
    if (rows.length === 0) return undefined;

    const byFile = new Map<string, string[]>();
    for (const r of rows) {
      const lines = byFile.get(r.file) ?? [];
      lines.push(`- \`${r.symbol}\` — ${r.signature}`);
      byFile.set(r.file, lines);
    }
    const out: string[] = [];
    for (const [file, lines] of byFile) {
      out.push(`### ${file}`);
      out.push(...lines);
    }
    runLog.info(`callers digest: ${rows.length} caller signature(s) attached`);
    return out.join('\n');
  }

  /**
   * T3 — fetch the cached repo skeleton for the prompt's `## Repo skeleton`
   * slot. Returns `undefined` when repo-intel is off / the repo isn't indexed
   * (the facade degrades), so the prompt stays identical to the pre-T3 shape.
   */
  private async buildRepoMapDigest(
    repoId: string,
    runLog: RunLogger,
  ): Promise<string | undefined> {
    try {
      const map = await this.container.repoIntel.getRepoMap(repoId);
      if (map.degraded || map.text.trim().length === 0) return undefined;
      runLog.info(`repo map: ${map.tokens} token(s) attached (cached=${map.cached})`);
      return map.text;
    } catch (err) {
      runLog.info(`repo map: repoIntel failed — ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * T3 — a one-line "N of M changed files are in the top 5% most-depended-on"
   * note appended to the task framing, so the model prioritises hot core files.
   * Empty string when repo-intel is off / no changed file is hot.
   */
  private async buildRankNote(
    repoId: string,
    diff: UnifiedDiff,
    runLog: RunLogger,
  ): Promise<string> {
    const changedFiles = diff.files.map((f) => f.path);
    if (changedFiles.length === 0) return '';
    try {
      const ranks = await this.container.repoIntel.getFileRank(repoId, changedFiles);
      if (ranks.length === 0) return '';
      const hot = ranks.filter((r) => r.percentile >= 95);
      if (hot.length === 0) return '';
      runLog.info(`file rank: ${hot.length}/${changedFiles.length} changed file(s) in top 5%`);
      return `\n\n${hot.length} of ${changedFiles.length} changed file(s) are in the top 5% most-depended-on (high blast risk) — prioritise their correctness.`;
    } catch {
      return '';
    }
  }

  /**
   * A minimal RunTrace whose `log` is the run's full SSE buffer — persisted on
   * failure/cancel (and pre-work failures) so the events (and WHY it failed)
   * survive a reload, not just the in-memory stream.
   */
  private traceFromBuffer(
    runId: string,
    pull: PullRow,
    agent: AgentRow,
    grounding: string,
    durationMs = 0,
    specsRead: string[] = [],
    specsTokens: number[] = [],
  ): RunTrace {
    return {
      config: {
        agent: agent.name,
        version: String(agent.version),
        provider: agent.provider,
        model: agent.model,
        pr: pull.number,
        source: 'local',
      },
      stats: { duration_ms: durationMs, tokens_in: 0, tokens_out: 0, findings: 0, grounding },
      prompt_assembly: { system: agent.systemPrompt, skills: null, memory: null, specs: null, user: '' },
      tool_calls: [],
      raw_output: '',
      memory_pulled: [],
      // L05 T4 — populated when a pre-flight/LLM failure happens AFTER specs
      // were already read; stays `[]` (the default) when the failure is the
      // pre-flight check itself, since nothing was read yet in that case.
      specs_read: specsRead,
      specs_tokens: specsTokens,
      log: this.container.runBus.buffer(runId).map((e) => ({ t: e.t, kind: e.kind, msg: e.msg })),
    };
  }

  /**
   * L05 T4 — build the "Project context" digest: the effective attached-
   * document set for this agent (its own attached paths, then its enabled
   * linked skills' attached paths in skill order, deduped first-occurrence-
   * wins — AC-18, AC-19), pre-flight-validated against a FRESH discovery pass
   * (AC-22, AC-29, AC-33), then read + tokenized (AC-25, AC-26).
   *
   * Fail-CLOSED, NOT fail-soft like `buildCallersDigest`/`buildRepoMapDigest`
   * above: any path outside the fresh whitelist — traversal, absolute,
   * symlink-escape, a renamed/deleted file, or "repo not cloned" with a
   * non-empty effective set — logs the exact offending path(s) via
   * `runLog.error` and THROWS, before any file is read and before
   * `reviewPullRequest` (i.e. before any LLM call) — AC-30, AC-31, AC-32.
   * Callers must let this propagate; it is meant to fail the run.
   *
   * Takes the full repo row (not just its id) — `runOneAgent` already has it
   * (loaded once for the whole batch), and `container.git.readFile` needs the
   * `{ owner, name }` RepoRef shape, exactly like `loadDiff` does above.
   */
  private async buildSpecsDigest(
    agent: AgentRow,
    repo: typeof schema.repos.$inferSelect,
    workspaceId: string,
    runLog: RunLogger,
  ): Promise<{ specs: string[]; specsRead: string[]; tokens: number[] }> {
    // ---- 1. Effective set: agent's own paths first, then each ENABLED
    // linked skill's paths in skill order; dedupe by path, first occurrence
    // wins (AC-18). A disabled skill contributes nothing (AC-19). Null/absent/
    // empty lists on either side are treated identically — no-op (AC-14). ----
    const seen = new Set<string>();
    const effective: string[] = [];
    const addAll = (paths: string[] | null | undefined) => {
      for (const p of paths ?? []) {
        if (seen.has(p)) continue;
        seen.add(p);
        effective.push(p);
      }
    };
    addAll(agent.attachedContextPaths);
    const linkedSkills = await this.agents.linkedSkills(agent.id);
    for (const link of linkedSkills) {
      if (!link.enabled) continue;
      addAll(link.skill.attachedContextPaths);
    }

    if (effective.length === 0) return { specs: [], specsRead: [], tokens: [] };

    // ---- 2. Pre-flight — re-verify EVERY path against a FRESH discovery
    // pass (AC-22, AC-29, AC-33): a path that was valid at attach time is
    // NEVER trusted from storage alone. Any escape/traversal/symlink-escape
    // path, any renamed/deleted file, or a wholly unresolvable repo (no
    // clone) fails the run immediately — before any read, before the LLM
    // call (AC-30, AC-31). ---------------------------------------------------
    const known = await this.container.context.listPaths(workspaceId, repo.id);
    if (known === null) {
      const msg =
        `Project context pre-flight failed: repo "${repo.owner}/${repo.name}" has no clone on ` +
        `disk, but ${effective.length} attached document(s) are configured: ${effective.join(', ')}`;
      runLog.error(msg);
      throw new Error(msg);
    }
    const offending = effective.filter((p) => !known.has(p));
    if (offending.length > 0) {
      const msg =
        `Project context pre-flight failed: attached document(s) not found in the current ` +
        `discovery set: ${offending.join(', ')}`;
      runLog.error(msg);
      throw new Error(msg);
    }

    // ---- 3. Read + tokenize, in effective-set order (AC-23, AC-25, AC-26). -
    // TOCTOU guard: a path can still vanish BETWEEN the fresh listPaths() pass
    // above and this read (e.g. a concurrent `resync`'s `git reset --hard` on
    // the same clone) — the same race T1's `ContextService.readOne` already
    // guards against. Never let a raw fs error (whose `.message` embeds the
    // ABSOLUTE clone path) escape to `runLog.error`/the persisted trace log —
    // map it to a clean, path-only message instead.
    const ref = { owner: repo.owner, name: repo.name };
    const specs: string[] = [];
    const specsRead: string[] = [];
    const tokens: number[] = [];
    for (const path of effective) {
      let content: string;
      try {
        content = await this.container.git.readFile(ref, path);
      } catch {
        const msg = `Project context: document vanished during read: ${path}`;
        runLog.error(msg);
        throw new Error(msg);
      }
      specs.push(content);
      specsRead.push(path);
      tokens.push(this.container.tokenizer.count(content));
    }
    runLog.info(
      `Project context: ${specsRead.length} document(s) attached (${tokens.reduce((a, b) => a + b, 0)} token(s) total)`,
    );
    return { specs, specsRead, tokens };
  }
}

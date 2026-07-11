// no imports — agent/parallel/phase/log/args are injected globals
export const meta = {
  name: 'sdd',
  description:
    'SDD implement pipeline: resolves a Development Plan, dispatches implementer(s), ' +
    'gates on plan-verifier, runs architecture (+ conditional security/api-contract) review, ' +
    'runs a bounded MUST-fix loop, and returns a structured report. Does not commit.',
  phases: [
    { title: 'Preflight' },
    { title: 'Implement' },
    { title: 'Verify' },
    { title: 'Review' },
    { title: 'Fix loop' },
    { title: 'Report' },
  ],
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

// Phase 0 — resolved + parsed Development Plan.
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['planPath', 'sourceSpecPath', 'executionMode', 'tasks', 'contextDigest'],
  properties: {
    planPath: { type: 'string' },
    sourceSpecPath: { type: 'string' }, // '' if the plan names none
    executionMode: { type: 'string', enum: ['single', 'multi'] },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id', 'title', 'targetModule', 'filesToTouch', 'dependsOn',
          'description', 'skillsToApply', 'insightsToRead', 'testCommand', 'definitionOfDone',
        ],
        properties: {
          id: { type: 'string' }, // e.g. 'T1'
          title: { type: 'string' },
          targetModule: { type: 'string' },
          filesToTouch: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } }, // [] if none
          description: { type: 'string' },
          skillsToApply: { type: 'array', items: { type: 'string' } },
          insightsToRead: { type: 'array', items: { type: 'string' } },
          testCommand: { type: 'string' },
          definitionOfDone: { type: 'string' },
        },
      },
    },
    contextDigest: { type: 'string' }, // plain-text digest of goal/scope/insights/spec for downstream prompts
  },
}

// Phase 1 / retry dispatches — one implementer's outcome for a single task.
const TASK_OUTCOME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'status', 'filesChanged', 'notes'],
  properties: {
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    filesChanged: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

// Phase 2 — plan-verifier's per-task verdict.
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['taskVerdicts'],
  properties: {
    taskVerdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'verdict', 'evidence'],
        properties: {
          taskId: { type: 'string' },
          verdict: { type: 'string', enum: ['met', 'partial', 'unmet'] },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

// Phase 3 — MUST/SHOULD findings, shared by architecture-reviewer and api-contract-reviewer
// (mirrors pr-self-review.js's FINDINGS_SCHEMA shape).
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'rule', 'file', 'line', 'excerpt', 'why', 'fix_hint'],
        properties: {
          severity: { type: 'string', enum: ['MUST', 'SHOULD'] },
          rule: { type: 'string' }, // e.g. 'onion.MUST.1'
          file: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          excerpt: { type: 'string' },
          why: { type: 'string' },
          fix_hint: { type: 'string' },
        },
      },
    },
  },
}

// Phase 3 — security-reviewer uses a separate severity/confidence taxonomy (Critical/High/
// Medium/Low + confidence), not MUST/SHOULD. Normalized into FINDINGS_SCHEMA shape afterward.
const SECURITY_FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'confidence', 'category', 'file', 'line', 'excerpt', 'why', 'fix_hint'],
        properties: {
          severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string' }, // OWASP category
          file: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          excerpt: { type: 'string' },
          why: { type: 'string' },
          fix_hint: { type: 'string' },
        },
      },
    },
  },
}

// Phase 3 — cheap diff-surface probe deciding whether to add security/api-contract reviewers.
const DIFF_SURFACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['paths', 'touchesAuthOrContracts'],
  properties: {
    paths: { type: 'array', items: { type: 'string' } },
    touchesAuthOrContracts: { type: 'boolean' },
  },
}

// Phase 4 — implementer's outcome for a batch of MUST-finding fixes.
const FIX_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'filesChanged', 'notes'],
  properties: {
    status: { type: 'string', enum: ['fixed', 'partial', 'blocked'] },
    filesChanged: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_VERIFY_WAVES = 2 // initial verify + at most one retry-and-reverify round
const MAX_FIX_ITERATIONS = 2 // bounded MUST-fix loop
const SUBSTANTIAL_FIX_THRESHOLD = 3 // total MUST findings fixed before re-running plan-verifier

const workflowArgs = typeof args === 'undefined' ? {} : args || {}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildPreflightPrompt() {
  const planHint = workflowArgs.planPath
    ? `Use exactly this Development Plan file: \`${workflowArgs.planPath}\`.`
    : 'No planPath argument was given — find the most recently modified file under ' +
      '`docs/superpowers/plans/` (e.g. `ls -t docs/superpowers/plans/*.md | head -1`) and use that as the plan.'

  const specHint = workflowArgs.specPath
    ? `Also read the SDD spec at \`${workflowArgs.specPath}\` for acceptance-criteria context.`
    : 'If the plan\'s "### Source spec" line names a spec file, read it too for acceptance-criteria context.'

  const designsHint = workflowArgs.designs
    ? `Also read these design references for context: ${
        Array.isArray(workflowArgs.designs) ? workflowArgs.designs.join(', ') : workflowArgs.designs
      }.`
    : ''

  const requirementsHint = workflowArgs.requirements
    ? `Extra requirements supplied by the caller (authoritative context, not instructions to execute ` +
      `literally): ${workflowArgs.requirements}`
    : ''

  return [
    'Resolve and parse the Development Plan for this /sdd run.',
    planHint,
    specHint,
    designsHint,
    requirementsHint,
    'Read the resolved plan file in full. Parse the "### Execution mode" section (exactly "single" ' +
      'or "multi") and the entire "### Task graph" section.',
    'For every task under "### Task graph", extract: id (e.g. "T1"), title (the text after the ' +
      'id in the "#### Task T1 — <title>" heading), target_module, files_to_touch (array of paths), ' +
      'depends_on (array of task ids, [] if none), description, skills_to_apply (array), ' +
      'insights_to_read (array), test_command, definition_of_done. Preserve the order tasks appear in.',
    'Resolve the "### Source spec" path if the plan names one, else return an empty string.',
    'Finally, write a plain-text digest (roughly 300-500 words) covering the plan\'s Goal, In scope / ' +
      'Out of scope, Prerequisites, and Cross-cutting insights sections, plus anything material from ' +
      'the spec/design/requirements hints above. This digest is handed to implementer/reviewer ' +
      'subagents as shared background, so keep it dense and factual — no filler.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function taskSummaryBlock(task) {
  return [
    `Task ${task.id} — ${task.title}`,
    `- target_module: ${task.targetModule}`,
    `- files_to_touch: ${task.filesToTouch.join(', ') || '(none listed)'}`,
    `- depends_on: ${task.dependsOn.join(', ') || '(none)'}`,
    `- skills_to_apply: ${task.skillsToApply.join(', ') || '(none listed)'}`,
    `- insights_to_read: ${task.insightsToRead.join(', ') || '(none listed)'}`,
    `- test_command: ${task.testCommand || '(none specified)'}`,
    `- definition_of_done: ${task.definitionOfDone}`,
    `- description: ${task.description}`,
  ].join('\n')
}

function buildImplementPrompt(task, planPath, contextDigest) {
  return [
    `Execute exactly Task ${task.id} from the Development Plan at \`${planPath}\`. Do not touch any ` +
      "other task's files and do not expand scope beyond files_to_touch.",
    'Shared plan context digest:',
    contextDigest || '(no digest provided)',
    "This task's fields (also present verbatim in the plan file — read the plan for full context):",
    taskSummaryBlock(task),
    'Apply skills_to_apply and read insights_to_read, run test_command as part of your self-check ' +
      'loop, and only report status "done" once definition_of_done is actually met.',
  ].join('\n\n')
}

function buildVerifyPrompt(planPath, tasks) {
  return [
    `Verify completion of the following tasks from the Development Plan at \`${planPath}\` against ` +
      "the current diff. Re-derive every verdict yourself from the diff and test runs — never trust " +
      "an implementer's self-report.",
    tasks.map(taskSummaryBlock).join('\n\n'),
    'For each task, return taskId, verdict (met | partial | unmet), and evidence describing what you ' +
      'checked and what you found.',
  ].join('\n\n')
}

function buildFixPrompt(findings) {
  return [
    'Fix exactly the following MUST-severity findings from the review (architecture, api-contract, ' +
      'and/or security). Do not address SHOULD findings. Do not expand scope beyond what is needed ' +
      'to resolve these findings.',
    JSON.stringify(findings, null, 2),
  ].join('\n\n')
}

function buildRecheckPrompt(findings) {
  return [
    'Re-check whether the following previously reported MUST findings are resolved in the current ' +
      'diff. Return only findings that are STILL present (unresolved) or newly introduced as a side ' +
      'effect of the fix — do not re-report anything already resolved.',
    JSON.stringify(findings, null, 2),
  ].join('\n\n')
}

const ARCHITECTURE_REVIEW_PROMPT =
  'Run your standard architectural review process against the current uncommitted diff produced by ' +
  'this /sdd implement run. Report every MUST/SHOULD finding per your usual output contract.'

const SECURITY_REVIEW_PROMPT =
  'Run your standard adversarial security review against the current uncommitted diff. This diff ' +
  'touches auth- or contract-adjacent paths, so treat it as elevated risk. Report findings per your ' +
  'usual severity/confidence contract.'

const API_CONTRACT_REVIEW_PROMPT =
  'Run your standard API-contract review against the current uncommitted diff. This diff touches ' +
  'auth- or contract-adjacent paths. Report findings per your usual MUST/SHOULD contract.'

const SURFACE_DETECTION_PROMPT =
  'Run `git diff --name-only HEAD` and `git ls-files --others --exclude-standard`, union and dedupe ' +
  'the results into a list of changed paths. Set touchesAuthOrContracts=true if ANY changed path ' +
  "contains 'auth', 'session', 'token', 'permission', 'rbac', is named or contains 'routes.ts'/" +
  "'routes/', contains 'contracts/', 'schema', 'dto', or is under mcp/ tool registration. Return the " +
  'deduplicated path list and the boolean.'

// ---------------------------------------------------------------------------
// Wave / dependency helpers
// ---------------------------------------------------------------------------

// Groups tasks into dependency waves via a simple topological sort. A task is
// "ready" once every id in its depends_on has already been placed in an earlier
// wave (or doesn't exist in the plan at all — treated as satisfied rather than
// deadlocking on a typo'd id; plan-verifier will surface any resulting gap).
function computeWaves(tasks) {
  const knownIds = new Set(tasks.map(t => t.id))
  const doneIds = new Set()
  const waves = []
  let remaining = tasks.slice()

  while (remaining.length > 0) {
    const ready = remaining.filter(t => t.dependsOn.every(dep => doneIds.has(dep) || !knownIds.has(dep)))
    if (ready.length === 0) {
      // Circular or unresolvable dependency graph — dispatch what's left as one
      // final wave rather than looping forever.
      waves.push(remaining)
      break
    }
    waves.push(ready)
    ready.forEach(t => doneIds.add(t.id))
    remaining = remaining.filter(t => !ready.includes(t))
  }
  return waves
}

// The planner guarantees disjoint files_to_touch within a wave, but if that
// guarantee is violated, mark the offending tasks for worktree isolation
// instead of letting parallel writers race on the same file.
function findOverlappingTaskIds(wave) {
  const ownerByFile = new Map()
  const overlapping = new Set()
  for (const task of wave) {
    for (const file of task.filesToTouch) {
      const owner = ownerByFile.get(file)
      if (owner && owner !== task.id) {
        overlapping.add(owner)
        overlapping.add(task.id)
      } else {
        ownerByFile.set(file, task.id)
      }
    }
  }
  return overlapping
}

async function implementTasks(tasks, mode, planPath, contextDigest) {
  if (tasks.length === 0) return []

  if (mode === 'multi') {
    const overlapping = findOverlappingTaskIds(tasks)
    const thunks = tasks.map(task => () =>
      agent(buildImplementPrompt(task, planPath, contextDigest), {
        agentType: 'implementer',
        model: 'sonnet',
        label: `implement:${task.id}`,
        phase: 'Implement',
        schema: TASK_OUTCOME_SCHEMA,
        ...(overlapping.has(task.id) ? { isolation: 'worktree' } : {}),
      })
    )
    return parallel(thunks)
  }

  // single = sequential dispatch, one task at a time.
  const results = []
  for (const task of tasks) {
    results.push(
      await agent(buildImplementPrompt(task, planPath, contextDigest), {
        agentType: 'implementer',
        model: 'sonnet',
        label: `implement:${task.id}`,
        phase: 'Implement',
        schema: TASK_OUTCOME_SCHEMA,
      })
    )
  }
  return results
}

function normalizeSecurityFindings(items) {
  return items.map(f => ({
    severity: f.severity === 'Critical' || f.severity === 'High' ? 'MUST' : 'SHOULD',
    rule: `security.${f.category || 'owasp'}`,
    file: f.file,
    line: f.line,
    excerpt: f.excerpt,
    why: f.why,
    fix_hint: f.fix_hint,
    detail: { source: 'security-reviewer', originalSeverity: f.severity, confidence: f.confidence },
  }))
}

// ---------------------------------------------------------------------------
// Phase 0 — Preflight
// ---------------------------------------------------------------------------

phase('Preflight')

const preflight = await agent(buildPreflightPrompt(), {
  label: 'preflight',
  phase: 'Preflight',
  schema: PLAN_SCHEMA,
})

if (!preflight || !preflight.planPath || !Array.isArray(preflight.tasks) || preflight.tasks.length === 0) {
  return {
    implemented: [],
    verify: null,
    review: { must: [], should: [] },
    fixes: [],
    remaining: {
      error:
        'Could not resolve a Development Plan to execute. Pass planPath explicitly or ensure ' +
        'docs/superpowers/plans/ contains a plan matching the implementation-planner output format.',
    },
  }
}

log(
  `Resolved plan: ${preflight.planPath} (execution_mode=${preflight.executionMode}, ` +
    `tasks=${preflight.tasks.length})`
)

// ---------------------------------------------------------------------------
// Phase 1 — Implement
// ---------------------------------------------------------------------------

phase('Implement')

let implementResults = []

if (preflight.executionMode === 'multi') {
  const waves = computeWaves(preflight.tasks)
  log(`Multi-agent mode: ${waves.length} dependency wave(s).`)
  for (let i = 0; i < waves.length; i++) {
    log(`Implement wave ${i + 1}/${waves.length}: ${waves[i].map(t => t.id).join(', ')}`)
    const waveResults = await implementTasks(waves[i], 'multi', preflight.planPath, preflight.contextDigest)
    implementResults.push(...waveResults)
  }
} else {
  log(`Single-agent mode: ${preflight.tasks.length} task(s), sequential dispatch.`)
  implementResults = await implementTasks(preflight.tasks, 'single', preflight.planPath, preflight.contextDigest)
}

// ---------------------------------------------------------------------------
// Phase 2 — Verify (gate), runs BEFORE review
// ---------------------------------------------------------------------------

phase('Verify')

let verifyRound = 0
let latestVerdicts = []
let tasksInScope = preflight.tasks.map(t => t.id)

while (verifyRound < MAX_VERIFY_WAVES) {
  verifyRound++
  const scopedTasks = preflight.tasks.filter(t => tasksInScope.includes(t.id))
  const verdictResult = await agent(buildVerifyPrompt(preflight.planPath, scopedTasks), {
    agentType: 'plan-verifier',
    model: 'sonnet',
    label: `verify:wave-${verifyRound}`,
    phase: 'Verify',
    schema: VERDICT_SCHEMA,
  })

  latestVerdicts = verdictResult?.taskVerdicts ?? []
  const unresolved = latestVerdicts.filter(v => v.verdict !== 'met')
  log(`Verify wave ${verifyRound}: ${latestVerdicts.length - unresolved.length}/${latestVerdicts.length} met.`)

  if (unresolved.length === 0) break
  if (verifyRound >= MAX_VERIFY_WAVES) {
    log(`Verify gate exhausted after ${MAX_VERIFY_WAVES} wave(s); ${unresolved.length} task(s) still not met.`)
    break
  }

  const retryTasks = preflight.tasks.filter(t => unresolved.some(v => v.taskId === t.id))
  const retryResults = await implementTasks(
    retryTasks,
    preflight.executionMode,
    preflight.planPath,
    preflight.contextDigest
  )
  implementResults.push(...retryResults)
  tasksInScope = retryTasks.map(t => t.id)
}

// ---------------------------------------------------------------------------
// Phase 3 — Review (architecture-reviewer always; security/api-contract conditionally)
// ---------------------------------------------------------------------------

phase('Review')

const surfaces = await agent(SURFACE_DETECTION_PROMPT, {
  label: 'detect-surfaces',
  phase: 'Review',
  schema: DIFF_SURFACE_SCHEMA,
})

const reviewJobs = [
  {
    kind: 'architecture',
    thunk: () =>
      agent(ARCHITECTURE_REVIEW_PROMPT, {
        agentType: 'architecture-reviewer',
        model: 'sonnet',
        label: 'review:architecture',
        phase: 'Review',
        schema: FINDINGS_SCHEMA,
      }),
  },
]

if (surfaces?.touchesAuthOrContracts) {
  reviewJobs.push({
    kind: 'security',
    thunk: () =>
      agent(SECURITY_REVIEW_PROMPT, {
        agentType: 'security-reviewer',
        model: 'sonnet',
        label: 'review:security',
        phase: 'Review',
        schema: SECURITY_FINDINGS_SCHEMA,
      }),
  })
  reviewJobs.push({
    kind: 'apiContract',
    thunk: () =>
      agent(API_CONTRACT_REVIEW_PROMPT, {
        agentType: 'api-contract-reviewer',
        model: 'sonnet',
        label: 'review:api-contract',
        phase: 'Review',
        schema: FINDINGS_SCHEMA,
      }),
  })
}
// Note: test-writer is deliberately never dispatched from this workflow.

const reviewResults = await parallel(reviewJobs.map(j => j.thunk))
const reviewByKind = {}
reviewJobs.forEach((job, i) => {
  reviewByKind[job.kind] = reviewResults[i]
})

const architectureFindings = reviewByKind.architecture?.findings ?? []
const apiContractFindings = reviewByKind.apiContract?.findings ?? []
const securityFindings = normalizeSecurityFindings(reviewByKind.security?.findings ?? [])

const allReviewFindings = [...architectureFindings, ...apiContractFindings, ...securityFindings]
const shouldFindings = allReviewFindings.filter(f => f.severity === 'SHOULD')
const initialMustFindings = allReviewFindings.filter(f => f.severity === 'MUST')

log(`Review: ${initialMustFindings.length} MUST, ${shouldFindings.length} SHOULD finding(s).`)

// ---------------------------------------------------------------------------
// Phase 4 — Fix loop (MUST findings only, bounded; SHOULD surfaced, never auto-fixed)
// ---------------------------------------------------------------------------

phase('Fix loop')

const fixes = []
let mustFindings = initialMustFindings
let fixIteration = 0

while (mustFindings.length > 0 && fixIteration < MAX_FIX_ITERATIONS) {
  fixIteration++
  log(`Fix iteration ${fixIteration}/${MAX_FIX_ITERATIONS}: addressing ${mustFindings.length} MUST finding(s).`)

  const fixResult = await agent(buildFixPrompt(mustFindings), {
    agentType: 'implementer',
    model: 'sonnet',
    label: `fix:iteration-${fixIteration}`,
    phase: 'Fix loop',
    schema: FIX_RESULT_SCHEMA,
  })

  fixes.push({ iteration: fixIteration, findingsAddressed: mustFindings, outcome: fixResult })

  const recheck = await agent(buildRecheckPrompt(mustFindings), {
    agentType: 'architecture-reviewer',
    model: 'sonnet',
    label: `review:recheck-${fixIteration}`,
    phase: 'Fix loop',
    schema: FINDINGS_SCHEMA,
  })

  mustFindings = (recheck?.findings ?? []).filter(f => f.severity === 'MUST')
}

const totalMustFindingsFixed = fixes.reduce((sum, f) => sum + f.findingsAddressed.length, 0)
const fixesWereSubstantial = totalMustFindingsFixed >= SUBSTANTIAL_FIX_THRESHOLD

let postFixVerify = null
if (fixes.length > 0 && fixesWereSubstantial) {
  log(`Fixes were substantial (${totalMustFindingsFixed} MUST findings addressed) — re-running plan-verifier.`)
  postFixVerify = await agent(buildVerifyPrompt(preflight.planPath, preflight.tasks), {
    agentType: 'plan-verifier',
    model: 'sonnet',
    label: 'verify:post-fix',
    phase: 'Fix loop',
    schema: VERDICT_SCHEMA,
  })
}

// ---------------------------------------------------------------------------
// Phase 5 — Report (structured summary; no commit)
// ---------------------------------------------------------------------------

phase('Report')

return {
  implemented: implementResults,
  verify: {
    rounds: verifyRound,
    verdicts: latestVerdicts,
    postFix: postFixVerify,
  },
  review: {
    must: initialMustFindings,
    should: shouldFindings,
  },
  fixes,
  remaining: {
    unresolvedMustFindings: mustFindings,
    unmetOrPartialTasks: latestVerdicts.filter(v => v.verdict !== 'met'),
  },
}

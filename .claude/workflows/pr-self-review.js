export const meta = {
  name: 'pr-self-review',
  description:
    'Second-pass architectural review of uncommitted diff before claiming a task ready. ' +
    'Detects whether client/ and/or server/ changed, dispatches parallel review agents loaded ' +
    'with the architecture skills + matching framework skills, returns structured findings.',
  phases: [
    { title: 'Detect surfaces' },
    { title: 'Review' },
    { title: 'Synthesize' },
  ],
}

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
          rule: { type: 'string' },           // e.g. 'ui-arch.MUST.4'
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

phase('Detect surfaces')

// One agent does the file discovery — it can shell out to git via Bash.
// We don't have shell access from the workflow body itself.
const surfaces = await agent(
  "Run these two commands and union their outputs, then report which surfaces changed:\n" +
    "  1) git diff --name-only HEAD\n" +
    "  2) git ls-files --others --exclude-standard\n" +
    "Treat each line as a path. Set touchesClient=true if any path starts with 'client/'. " +
    "Set touchesServer=true if any path starts with 'server/'. Return both flags plus the " +
    "deduplicated list of paths.",
  {
    label: 'detect-surfaces',
    phase: 'Detect surfaces',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['touchesClient', 'touchesServer', 'paths'],
      properties: {
        touchesClient: { type: 'boolean' },
        touchesServer: { type: 'boolean' },
        paths: { type: 'array', items: { type: 'string' } },
      },
    },
  }
)

if (!surfaces || (!surfaces.touchesClient && !surfaces.touchesServer)) {
  return { must: [], should: [], partial: false, skipped: true }
}

phase('Review')

// --- VARIANT A (use if Task 1 verdict = SUCCESS): skill loading ---
const clientPrompt =
  "Invoke these skills first: ui-architecture, react-best-practices, react-testing-library. " +
  "Then read every changed file under client/ (paths listed below). For each MUST/SHOULD rule, " +
  "apply the Detection hints from the ui-architecture skill. Report every violation as a finding " +
  "with severity, rule id (e.g. 'ui-arch.MUST.4'), file, line, excerpt, why, fix_hint. " +
  "If no violations, return an empty findings array.\n\nChanged paths:\n" +
  surfaces.paths.filter(p => p.startsWith('client/')).join('\n')

const serverPrompt =
  "Invoke these skills first: onion-architecture, fastify-best-practices, drizzle-orm-patterns. " +
  "Then read every changed file under server/ (paths listed below). For each MUST/SHOULD rule, " +
  "apply the Detection hints from the onion-architecture skill. Report every violation as a finding " +
  "with severity, rule id (e.g. 'onion.MUST.1'), file, line, excerpt, why, fix_hint. " +
  "If no violations, return an empty findings array.\n\nChanged paths:\n" +
  surfaces.paths.filter(p => p.startsWith('server/')).join('\n')

const reviews = await parallel(
  [
    surfaces.touchesClient
      ? () => agent(clientPrompt, { label: 'review:client', phase: 'Review', schema: FINDINGS_SCHEMA })
      : null,
    surfaces.touchesServer
      ? () => agent(serverPrompt, { label: 'review:server', phase: 'Review', schema: FINDINGS_SCHEMA })
      : null,
  ].filter(Boolean)
)

phase('Synthesize')

const expected = (surfaces.touchesClient ? 1 : 0) + (surfaces.touchesServer ? 1 : 0)
const succeeded = reviews.filter(Boolean)
const partial = succeeded.length < expected

const all = succeeded.flatMap(r => r.findings)
return {
  must: all.filter(f => f.severity === 'MUST'),
  should: all.filter(f => f.severity === 'SHOULD'),
  partial,
  skipped: false,
}

import type { Db } from './client.js';
import * as t from './schema.js';
import { eq, and } from 'drizzle-orm';

export const TEST_COVERAGE_NUDGE = `# Test Coverage Nudge

You are reviewing a pull request that adds or modifies test files. Examine the diff for the following test-quality issues and flag each one with a precise \`file:line\` citation:

1. **Happy-path-only tests.** If a function under test has branches (early returns, error paths, conditional logic) and only the success path is asserted, flag the untested branch(es) explicitly: "X tests the happy path; missing case Y at file:line".
2. **Missing edge cases.** For each new function, ask: what happens at 0, negative inputs, empty arrays, undefined, max-value, off-by-one boundaries? If a clearly relevant edge case is not exercised, flag it.
3. **Over-mocking.** A test that mocks the subject under test, mocks every collaborator, or asserts only against mock call counts (not real behavior) is a smell. Flag with: "Mock-heavy: this asserts the test setup, not the behavior".
4. **Likely flakes.** Time-dependent assertions (\`Date.now()\`, \`setTimeout\`), order-dependent iteration over hash maps, network calls without a fake, race-prone concurrency without a sync barrier — flag each with the specific concern.

For every finding, cite the exact file and line from the diff. Do not invent line numbers. If you cannot ground a concern to a specific line, do not emit it.
`;

export const API_CONTRACT_GATE = `# API Contract Gate

You are reviewing a pull request that may change a public API contract. Examine the diff for the following breaking-change patterns and flag each one with severity \`error\` and a precise \`file:line\` citation:

1. **Renamed or removed response fields** on any route's response schema (Zod, JSON Schema, OpenAPI). Existing clients will break. Flag with: "Breaking: response field X renamed to Y at file:line".
2. **Tightened request validation** — a field that was optional becoming required, an enum gaining a non-additive constraint, a string field gaining a min-length or pattern that prior valid requests would fail. Flag with: "Breaking: request validation tightened at file:line".
3. **Removed routes** or removed methods on a route. Flag with: "Breaking: route X removed at file:line".
4. **Changed HTTP status semantics** — a route that used to return 200 now returning 201 or 204, or a 4xx becoming a 5xx. Flag with: "Breaking: status code change at file:line".
5. **Removed query/path parameters** or renamed them. Flag with: "Breaking: parameter renamed/removed at file:line".

For every finding, cite the exact file and line from the diff. Additive changes (new optional fields, new routes, new optional query params) are NOT breaking and should NOT be flagged.
`;

const TEST_QUALITY_SYSTEM_PROMPT = `You are a Test Quality Reviewer. Examine the diff for missing branch coverage, untested edge cases, over-mocking, and likely flakes. Cite exact file:line. Be precise; do not invent findings.`;

export async function seedWithSkills(db: Db, workspaceId: string, userId: string): Promise<void> {
  // ---- Skills ----
  const skillsToInsert = [
    {
      name: 'Test Coverage Nudge',
      description: 'Flags happy-path-only tests, missing edge cases, mock overuse, and likely flakes.',
      type: 'rubric' as const,
      source: 'manual' as const,
      body: TEST_COVERAGE_NUDGE,
    },
    {
      name: 'API Contract Gate',
      description:
        'Flags breaking API contract changes — renamed response fields, tightened request validation, removed routes.',
      type: 'security' as const,
      source: 'manual' as const,
      body: API_CONTRACT_GATE,
    },
  ];

  const skillIds: string[] = [];
  for (const s of skillsToInsert) {
    const [existing] = await db
      .select()
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.name, s.name)));
    if (existing) {
      skillIds.push(existing.id);
      continue;
    }
    const [row] = await db
      .insert(t.skills)
      .values({ workspaceId, ...s })
      .returning();
    skillIds.push(row!.id);
  }

  // ---- Agent ----
  const [existingAgent] = await db
    .select()
    .from(t.agents)
    .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, 'Test Quality Reviewer')));

  let agentId: string;
  if (existingAgent) {
    agentId = existingAgent.id;
  } else {
    const [row] = await db
      .insert(t.agents)
      .values({
        workspaceId,
        name: 'Test Quality Reviewer',
        description: 'Flags missing branches, edge cases, mock overuse, and likely flakes in test diffs.',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        systemPrompt: TEST_QUALITY_SYSTEM_PROMPT,
        enabled: true,
        createdBy: userId,
      })
      .returning();
    agentId = row!.id;
  }

  // ---- Links ----
  for (let i = 0; i < skillIds.length; i++) {
    await db
      .insert(t.agentSkills)
      .values({ agentId, skillId: skillIds[i]!, order: i, enabled: true })
      .onConflictDoNothing();
  }
}

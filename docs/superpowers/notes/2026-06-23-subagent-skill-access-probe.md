# Subagent Skill access probe — 2026-06-23

## Probe
One-shot workflow that spawned a subagent and asked it to invoke
`Skill(skill='react-best-practices')` and return the first heading line.

## Result
- Verdict: SUCCESS
- Returned firstLine: `# React Best Practices & Anti-Patterns`

## Consequence for Task 4
- If SUCCESS: subagent prompts will read "Invoke the <name> skill before reviewing".
- If FAILURE: subagent prompts will inline the MUST/SHOULD rule list from the SKILL.md verbatim, plus the Detection hints block.

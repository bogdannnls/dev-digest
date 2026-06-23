/* helpers.ts — SkillEditor pure helpers.
   suggestSkillType: keyword-tally over name+description+body that picks the most
   likely SkillType. Conservative: returns null unless the top type clears a
   minimum hit count AND beats the runner-up by a margin, so ambiguous text
   stays on whatever the user already chose. No I/O, no React.

   Matching uses word boundaries (compiled regex per keyword) to avoid acronym
   substring traps — "rce" inside "enforce" must not flag a security skill. */

import type { SkillType } from "@devdigest/shared";

type SuggestableType = Exclude<SkillType, "custom">;

// Keep each entry as a full word/phrase. Internal hyphens are fine — `\b` only
// guards the outer boundaries. List variants explicitly rather than relying on
// stem matching (precision over breadth).
const KEYWORDS: Record<SuggestableType, readonly string[]> = {
  security: [
    "xss", "csrf", "ssrf", "idor", "rce", "xxe",
    "sql injection", "command injection", "path traversal", "prototype pollution",
    "owasp", "vulnerable", "vulnerability", "exploit",
    "authentication", "authorization",
    "password", "secret", "api key", "token", "jwt", "session cookie",
    "sanitize", "escape html", "csp", "cors",
    "encryption", "crypto", "hashing", "tls", "pii", "gdpr",
  ],
  convention: [
    "naming", "camelcase", "kebab-case", "snake_case", "pascalcase",
    "prefix", "suffix", "file name", "file names", "filename", "filenames",
    "directory structure", "import order", "barrel file", "path alias",
    "module boundary",
    "lint", "eslint", "prettier", "formatter",
    "indentation", "indent", "brace style", "semicolon", "quote style",
    "max line length", "line length",
  ],
  rubric: [
    "must", "should", "criteria", "checklist",
    "score", "rating", "evaluate", "grade", "pass/fail",
    "threshold", "rubric",
    "block the pr", "approve the pr", "reject the pr", "fail the review",
    "flag if",
  ],
};

export interface SkillTypeSuggestion {
  type: SuggestableType;
  score: number;
  matched: readonly string[];
}

const MIN_TEXT_LENGTH = 10;
const MIN_SCORE = 2;
const MIN_GAP = 1;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One compiled regex per keyword, reused across calls.
const COMPILED: Record<SuggestableType, ReadonlyArray<{ label: string; re: RegExp }>> = {
  security: KEYWORDS.security.map((kw) => ({ label: kw, re: new RegExp(`\\b${escapeRegex(kw)}\\b`, "i") })),
  convention: KEYWORDS.convention.map((kw) => ({ label: kw, re: new RegExp(`\\b${escapeRegex(kw)}\\b`, "i") })),
  rubric: KEYWORDS.rubric.map((kw) => ({ label: kw, re: new RegExp(`\\b${escapeRegex(kw)}\\b`, "i") })),
};

export function suggestSkillType(text: string): SkillTypeSuggestion | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH) return null;

  const tallies = (Object.keys(COMPILED) as SuggestableType[]).map((type) => {
    const matched: string[] = [];
    for (const { label, re } of COMPILED[type]) if (re.test(trimmed)) matched.push(label);
    return { type, score: matched.length, matched };
  });

  tallies.sort((a, b) => b.score - a.score);
  const [top, runnerUp] = tallies;
  if (!top || top.score < MIN_SCORE) return null;
  if (runnerUp && top.score - runnerUp.score < MIN_GAP) return null;
  return { type: top.type, score: top.score, matched: top.matched };
}

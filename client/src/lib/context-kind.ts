/* context-kind.ts — client-side derivation of a Project Context document's
   "kind" badge (specs / docs / insights / doc) from its path alone.

   AC-43: the badge is derived on the client from which configured discovery
   root a path falls under — NOT a stored field on SpecFile. The three known
   root names are matched as exact path SEGMENTS (split on "/"), never as a
   substring, so e.g. "team/specsheet/foo.md" does NOT match "specs".

   AC-43b: a path under a discovery root the server was reconfigured with,
   outside the three known names, falls back to the generic "doc" badge —
   never a crash, never a hidden document. */

export type ContextKind = "specs" | "docs" | "insights" | "doc";

const KNOWN_KINDS: ReadonlySet<string> = new Set(["specs", "docs", "insights"]);

function isKnownKind(segment: string): segment is "specs" | "docs" | "insights" {
  return KNOWN_KINDS.has(segment);
}

/** Derive the kind badge for a document's path. Pure, no I/O. */
export function deriveContextKind(path: string): ContextKind {
  const segments = path.split("/").filter(Boolean);
  const match = segments.find(isKnownKind);
  return match ?? "doc";
}

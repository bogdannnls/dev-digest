import { describe, it, expect } from "vitest";
import { deriveContextKind } from "./context-kind";

describe("deriveContextKind", () => {
  it("maps the three known discovery roots to their own badge, at any depth", () => {
    expect(deriveContextKind("specs/2026-07-11-feature-spec.md")).toBe("specs");
    expect(deriveContextKind("docs/architecture/overview.md")).toBe("docs");
    expect(deriveContextKind("insights/2026-07-01-learning.md")).toBe("insights");
    expect(deriveContextKind("backend/docs/nested/deep/notes.md")).toBe("docs");
  });

  it("falls back to the generic 'doc' badge for an unrecognized root (AC-43b), never crashing", () => {
    expect(deriveContextKind("archive/old-notes.md")).toBe("doc");
    expect(deriveContextKind("README.md")).toBe("doc");
    expect(deriveContextKind("")).toBe("doc");
  });

  it("matches root names as whole path segments only, not substrings", () => {
    // "specsheet" contains "specs" but is not the "specs" segment.
    expect(deriveContextKind("team/specsheet/foo.md")).toBe("doc");
    expect(deriveContextKind("my-docs/foo.md")).toBe("doc");
  });
});

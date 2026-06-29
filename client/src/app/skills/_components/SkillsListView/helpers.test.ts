import { describe, it, expect } from "vitest";
import type { Skill } from "@devdigest/shared";
import { filterSkills } from "./helpers";

const make = (overrides: Partial<Skill>): Skill => ({
  id: "1",
  name: "secret-leakage-gate",
  description: "Flag committed secrets",
  type: "security",
  source: "manual",
  body: "...",
  enabled: true,
  version: 1,
  evidence_files: null,
  ...overrides,
});

describe("filterSkills", () => {
  const all: Skill[] = [
    make({ id: "1", name: "secret-leakage-gate", type: "security" }),
    make({ id: "2", name: "pr-quality-rubric", type: "rubric" }),
    make({ id: "3", name: "no-then-chains", type: "convention" }),
  ];

  it("returns everything when no filters apply", () => {
    expect(filterSkills(all, "", new Set())).toEqual(all);
  });

  it("filters by name (case-insensitive substring)", () => {
    expect(filterSkills(all, "RUBRIC", new Set()).map((s) => s.id)).toEqual(["2"]);
  });

  it("filters by selected types (any-of)", () => {
    expect(
      filterSkills(all, "", new Set(["security", "convention"])).map((s) => s.id),
    ).toEqual(["1", "3"]);
  });

  it("combines search and type filters with AND", () => {
    expect(filterSkills(all, "no", new Set(["convention"])).map((s) => s.id)).toEqual(["3"]);
    expect(filterSkills(all, "no", new Set(["rubric"]))).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { suggestSkillType } from "./skill-type-suggest";

describe("suggestSkillType", () => {
  it("returns null for short / empty text", () => {
    expect(suggestSkillType("")).toBeNull();
    expect(suggestSkillType("   ")).toBeNull();
    expect(suggestSkillType("short")).toBeNull();
  });

  it("suggests security when XSS/CSRF/OWASP signals dominate", () => {
    const r = suggestSkillType(
      "Flag any unsanitized input that could lead to XSS. Validate CSRF tokens on every state-changing route. Reference OWASP A03.",
    );
    expect(r?.type).toBe("security");
    expect(r?.matched).toEqual(expect.arrayContaining(["xss", "csrf", "owasp"]));
  });

  it("suggests convention for naming + lint signals", () => {
    const r = suggestSkillType(
      "Use kebab-case for file names. Enforce eslint rules around import order. Apply path alias @app/* for src/app/*.",
    );
    expect(r?.type).toBe("convention");
  });

  it("suggests rubric for must/should/threshold language", () => {
    const r = suggestSkillType(
      "The reviewer must verify that every public function has a JSDoc block. Should flag if the threshold of 80% coverage is not met. Block the PR otherwise.",
    );
    expect(r?.type).toBe("rubric");
  });

  it("returns null when no type clears the minimum hit count", () => {
    expect(suggestSkillType("This is a generic skill that does some stuff.")).toBeNull();
  });

  it("returns null when top and runner-up are tied (ambiguous)", () => {
    // One security hit, one convention hit — gap is 0, below MIN_GAP.
    const r = suggestSkillType("Reject any code that uses xss-vulnerable HTML. Enforce kebab-case file names.");
    expect(r).toBeNull();
  });
});

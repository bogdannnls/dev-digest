import { describe, it, expect } from "vitest";
import { repoBlobUrl } from "./repo-source-urls";

describe("repoBlobUrl", () => {
  it("builds a GitHub blob URL on the default branch", () => {
    const url = repoBlobUrl("github", "acme/widgets", "main", "src/index.ts");
    expect(url).toBe("https://github.com/acme/widgets/blob/main/src/index.ts");
  });

  it("builds a Bitbucket /src URL", () => {
    const url = repoBlobUrl("bitbucket", "acme/widgets", "main", "src/index.ts");
    expect(url).toBe("https://bitbucket.org/acme/widgets/src/main/src/index.ts");
  });

  it("encodes branch and path segments without mangling slashes", () => {
    const url = repoBlobUrl(
      "github",
      "acme/widgets",
      "feature/login flow",
      "src/auth/login flow.ts",
    );
    expect(url).toBe(
      "https://github.com/acme/widgets/blob/feature%2Flogin%20flow/src/auth/login%20flow.ts",
    );
  });

  it("appends GitHub line anchors when start (and end) line is provided", () => {
    expect(repoBlobUrl("github", "acme/w", "main", "a.ts", 42)).toBe(
      "https://github.com/acme/w/blob/main/a.ts#L42",
    );
    expect(repoBlobUrl("github", "acme/w", "main", "a.ts", 42, 42)).toBe(
      "https://github.com/acme/w/blob/main/a.ts#L42",
    );
    expect(repoBlobUrl("github", "acme/w", "main", "a.ts", 42, 50)).toBe(
      "https://github.com/acme/w/blob/main/a.ts#L42-L50",
    );
  });

  it("uses Bitbucket #lines- anchor format", () => {
    expect(repoBlobUrl("bitbucket", "acme/w", "main", "a.ts", 42)).toBe(
      "https://bitbucket.org/acme/w/src/main/a.ts#lines-42",
    );
    expect(repoBlobUrl("bitbucket", "acme/w", "main", "a.ts", 42, 50)).toBe(
      "https://bitbucket.org/acme/w/src/main/a.ts#lines-42:50",
    );
  });

  it("omits the anchor when startLine is null/undefined", () => {
    expect(repoBlobUrl("github", "acme/w", "main", "a.ts", null)).toBe(
      "https://github.com/acme/w/blob/main/a.ts",
    );
    expect(repoBlobUrl("github", "acme/w", "main", "a.ts", undefined, 50)).toBe(
      "https://github.com/acme/w/blob/main/a.ts",
    );
  });
});

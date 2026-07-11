import { describe, it, expect } from "vitest";
import type { BlastRadius } from "@devdigest/shared";
import { buildBlastMermaid, type GraphPair } from "./blast-graph";

const pairsOf = (b: BlastRadius): GraphPair[] =>
  b.changed_symbols.map((symbol, i) => ({ symbol, downstream: b.downstream[i] }));

describe("buildBlastMermaid", () => {
  it("emits a graph LR with symbol → caller/endpoint/cron edges and typed classes", () => {
    const src = buildBlastMermaid(
      pairsOf({
        changed_symbols: [{ name: "rateLimit", file: "src/mw/rate.ts", kind: "function" }],
        downstream: [
          {
            symbol: "rateLimit",
            callers: [{ name: "x", file: "src/api/public/index.ts", line: 23 }],
            endpoints_affected: ["GET /api/public/items"],
            crons_affected: ["reset-rate-buckets"],
          },
        ],
        summary: "",
      }),
    );

    expect(src.startsWith("graph LR")).toBe(true); // MermaidDiagram requires a graph keyword
    expect(src).toContain('s0["rateLimit()"]:::sym');
    expect(src).toContain('"src/api/public/index.ts"');
    expect(src).toContain('"GET /api/public/items"');
    expect(src).toContain('"reset-rate-buckets"');
    // one edge from the symbol to each downstream node
    expect(src.match(/s0 --> /g)).toHaveLength(3);
  });

  it("dedupes a caller file reached from two symbols into a single shared node", () => {
    const src = buildBlastMermaid(
      pairsOf({
        changed_symbols: [
          { name: "a", file: "src/a.ts", kind: "function" },
          { name: "b", file: "src/b.ts", kind: "function" },
        ],
        downstream: [
          { symbol: "a", callers: [{ name: "x", file: "src/shared.ts", line: 1 }], endpoints_affected: [], crons_affected: [] },
          { symbol: "b", callers: [{ name: "y", file: "src/shared.ts", line: 9 }], endpoints_affected: [], crons_affected: [] },
        ],
        summary: "",
      }),
    );
    // exactly ONE declaration of the shared caller file, two edges into it
    expect(src.match(/"src\/shared\.ts"/g)).toHaveLength(1);
    expect(src.match(/ --> f0/g)).toHaveLength(2);
  });

  it("sanitizes brackets/quotes so Next.js dynamic-route paths stay parseable", () => {
    const src = buildBlastMermaid(
      pairsOf({
        changed_symbols: [{ name: "f", file: "src/f.ts", kind: "function" }],
        downstream: [
          { symbol: "f", callers: [{ name: "x", file: "src/app/[id]/page.tsx", line: 1 }], endpoints_affected: [], crons_affected: [] },
        ],
        summary: "",
      }),
    );
    expect(src).toContain("src/app/(id)/page.tsx");
    expect(src).not.toContain("[id]");
  });
});

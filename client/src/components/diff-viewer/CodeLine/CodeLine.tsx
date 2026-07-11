/* CodeLine — one rendered diff line: gutter number, +/- sign, text, plus the
   hover "+" affordance, any anchored comment threads, and an inline composer.
   When a finding is anchored to this line, an inline severity dot is shown at
   the end of the row; clicking it opens the finding drawer. */
"use client";

import React from "react";
import { SeverityBadge } from "@devdigest/ui";
import type { FindingRecord, Severity } from "@devdigest/shared";
import { commentTargetFor, type CommentThread, type DiffCommentApi, cs } from "../comments";
import { type Line } from "../helpers";
import { s, lineRowFor, lineSignFor } from "../styles";
import { CommentThreadView } from "../CommentThreadView";
import { InlineComposer } from "../InlineComposer";

export function CodeLine({
  ln,
  path,
  threads,
  commenting,
  finding,
  onFindingClick,
  registerRef,
}: {
  ln: Line;
  path: string;
  threads: CommentThread[];
  commenting?: DiffCommentApi;
  /** When set, this line has an anchored finding — renders an inline badge. */
  finding?: FindingRecord | null;
  onFindingClick?: (findingId: string) => void;
  /** Ref callback keyed by the parent so it can scrollIntoView on demand. */
  registerRef?: (el: HTMLDivElement | null) => void;
}) {
  const [hover, setHover] = React.useState(false);
  const [composing, setComposing] = React.useState(false);

  if (ln.kind === "hunk") {
    return (
      <div className="mono" style={s.hunk}>
        {ln.text}
      </div>
    );
  }

  const sign = ln.kind === "add" ? "+" : ln.kind === "del" ? "−" : "";
  const target = commenting?.canComment ? commentTargetFor(ln) : null;
  const showAdd = hover && !!target && !composing;

  return (
    <div
      ref={registerRef}
      style={cs.rowWrap}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={lineRowFor(ln.kind)}>
        <span className="mono tnum" style={{ ...s.lineNo, position: "relative" }}>
          {showAdd && target && (
            <button
              type="button"
              title="Add a comment on this line"
              aria-label="Add a comment on this line"
              onClick={() => setComposing(true)}
              style={cs.addBtn}
            >
              +
            </button>
          )}
          {ln.newNo ?? ln.oldNo ?? ""}
        </span>
        <span className="mono" style={lineSignFor(ln.kind)}>
          {sign}
        </span>
        <span className="mono" style={s.lineText}>
          {ln.text || " "}
        </span>
        {finding && (
          <button
            type="button"
            onClick={() => onFindingClick?.(finding.id)}
            title={finding.title}
            aria-label={`Open finding: ${finding.title}`}
            style={{
              marginLeft: 8,
              border: "none",
              background: "none",
              padding: 0,
              cursor: "pointer",
              display: "inline-flex",
              alignSelf: "center",
            }}
          >
            <SeverityBadge severity={finding.severity as Severity} compact />
          </button>
        )}
      </div>

      {commenting &&
        commenting.showComments &&
        threads.map((th) => (
          <CommentThreadView key={th.rootId} thread={th} commenting={commenting} path={path} />
        ))}

      {commenting && composing && target && (
        <InlineComposer
          commenting={commenting}
          path={path}
          line={target.line}
          side={target.side}
          onClose={() => setComposing(false)}
        />
      )}
    </div>
  );
}

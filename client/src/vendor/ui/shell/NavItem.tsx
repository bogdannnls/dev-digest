import React from "react";
import { Icon } from "../icons";
import { resolveHref, type NavItemDef } from "../nav";
import { DefaultLink } from "./DefaultLink";
import type { LinkLike } from "./types";

export function NavItem({
  item,
  active,
  repoId,
  Link = DefaultLink,
}: {
  item: NavItemDef;
  active?: boolean;
  repoId?: string | null;
  Link?: LinkLike;
}) {
  const I = Icon[item.icon];
  const [h, setH] = React.useState(false);
  const disabled = item.disabled === true;
  const row = (
    <div
      onMouseEnter={disabled ? undefined : () => setH(true)}
      onMouseLeave={disabled ? undefined : () => setH(false)}
      aria-disabled={disabled || undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "6px 9px",
        borderRadius: 6,
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        cursor: disabled ? "default" : "pointer",
        position: "relative",
        color: disabled
          ? "var(--text-secondary)"
          : active
            ? "var(--text-primary)"
            : h
              ? "var(--text-primary)"
              : "var(--text-secondary)",
        background: !disabled && active ? "var(--bg-hover)" : !disabled && h ? "var(--bg-elevated)" : "transparent",
        opacity: disabled ? 0.55 : 1,
        transition: "background .12s, color .12s",
      }}
    >
      {active && !disabled && (
        <span
          style={{
            position: "absolute",
            left: -8,
            top: 7,
            bottom: 7,
            width: 2.5,
            borderRadius: 2,
            background: "var(--accent)",
          }}
        />
      )}
      <I size={16} style={{ color: !disabled && active ? "var(--accent)" : "inherit" }} />
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.badge && !disabled && (
        <span
          className="tnum"
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--text-muted)",
            background: "var(--bg-surface)",
            border: "1px solid var(--border)",
            borderRadius: 99,
            padding: "0 8px",
            minWidth: 18,
            textAlign: "center",
          }}
        >
          {item.badge}
        </span>
      )}
    </div>
  );
  return disabled ? row : <Link href={resolveHref(item.href, repoId)}>{row}</Link>;
}

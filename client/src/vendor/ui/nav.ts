/* nav.ts — sidebar nav groups + keyboard shortcut registry.
   hrefs use :repoId token; the web app fills it from the active repo. */
import type { IconName } from "./icons";

export interface NavItemDef {
  key: string;
  label: string;
  icon: IconName;
  /** Route template; :repoId is replaced with the active repo id by the app. */
  href: string;
  /** Optional g-nav shortcut suffix (e.g. "p" → g then p). */
  gKey?: string;
  badge?: string;
  /** When true, render as a non-interactive placeholder (route not yet built). */
  disabled?: boolean;
}

export interface NavGroup {
  section: string;
  items: NavItemDef[];
}

/* Sections and item order mirror docs/DevDigest Design (standalone).html.
   Items without a built route carry `disabled: true` — they render as
   visible scaffolding so the shell matches the design without dead links. */
export const NAV: NavGroup[] = [
  {
    section: "WORKSPACE",
    items: [
      { key: "pulls", label: "Pull Requests", icon: "GitPullRequest", href: "/repos/:repoId/pulls", gKey: "p" },
      { key: "onboarding-tour", label: "Onboarding Tour", icon: "Workflow", href: "#", disabled: true },
      { key: "context", label: "Project Context", icon: "Folder", href: "#", disabled: true },
    ],
  },
  {
    section: "SKILLS LAB",
    items: [
      { key: "skills", label: "Skills", icon: "Sparkles", href: "#", disabled: true },
      { key: "agents", label: "Agents", icon: "Cpu", href: "/agents", gKey: "a" },
      { key: "conventions", label: "Conventions", icon: "ListChecks", href: "#", disabled: true },
      { key: "eval", label: "Eval Dashboard", icon: "Target", href: "#", disabled: true },
    ],
  },
  {
    section: "GLOBAL",
    items: [
      { key: "memory", label: "Memory", icon: "Brain", href: "#", disabled: true },
      { key: "multi-agent", label: "Multi-Agent Review", icon: "Users", href: "#", disabled: true },
      { key: "agent-performance", label: "Agent Performance", icon: "TrendingUp", href: "#", disabled: true },
      { key: "ci-runs", label: "CI Runs", icon: "Boxes", href: "#", disabled: true },
    ],
  },
];

export const SETTINGS_ITEM: NavItemDef = {
  key: "settings",
  label: "Settings",
  icon: "Settings",
  href: "/settings/api-keys",
  gKey: ",",
};

export const SETTINGS_SECTIONS = [
  { key: "api-keys", label: "API Keys" },
  { key: "models", label: "Feature Models" },
] as const;

/** Keyboard shortcut registry. Wiring is finalized by A6. */
export interface ShortcutDef {
  keys: string;
  label: string;
  group: "Navigation" | "Findings" | "Actions" | "Global";
}

export const SHORTCUTS: ShortcutDef[] = [
  { keys: "⌘K", label: "Open command palette", group: "Global" },
  { keys: "?", label: "Show keyboard shortcuts", group: "Global" },
  { keys: "g p", label: "Go to Pull Requests", group: "Navigation" },
  { keys: "g a", label: "Go to Agents", group: "Navigation" },
  { keys: "j / k", label: "Next / previous finding", group: "Findings" },
  { keys: "a", label: "Accept finding", group: "Findings" },
  { keys: "d", label: "Dismiss finding", group: "Findings" },
];

/** Resolve an :repoId-templated href against the active repo id. */
export function resolveHref(href: string, repoId: string | null | undefined): string {
  if (!href.includes(":repoId")) return href;
  return href.replace(":repoId", repoId ?? "_");
}

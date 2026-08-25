"use client";

import { useParams } from "next/navigation";
import { EvalAgentDashboardView } from "./_components/EvalAgentDashboardView/EvalAgentDashboardView";

/* Route: /eval-dashboard/:agentId (per-agent eval detail). Mirrors the
   existing dynamic-route convention in this codebase (agents/[id],
   repos/[repoId]/pulls) — a thin client page reading the id via
   `useParams` and delegating everything else to the colocated view. */
export default function EvalAgentDashboardPage() {
  const params = useParams<{ agentId: string }>();
  return <EvalAgentDashboardView agentId={params.agentId} />;
}

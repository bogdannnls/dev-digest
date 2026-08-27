import { EvalDashboardView } from "./_components/EvalDashboardView/EvalDashboardView";

/* Route: /eval-dashboard (Eval Dashboard landing view). Thin route entry —
   the view, its sub-tables, styles and i18n are colocated under
   _components/EvalDashboardView. Selecting an agent navigates to the
   per-agent detail at /eval-dashboard/:agentId. */
export default function EvalDashboardPage() {
  return <EvalDashboardView />;
}

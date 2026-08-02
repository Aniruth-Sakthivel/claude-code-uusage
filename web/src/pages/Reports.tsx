/** Workspace reports: status breakdowns, workload, and a completion trend. */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { ReportsSummary } from "../api/types";
import { HorizontalBars, TrendBars } from "../components/charts/WorkspaceCharts";
import { Card, CardHead, EmptyState, ErrorState, Eyebrow, LoadingState } from "../components/ui";

const TASK_STATUS_LABEL: Record<string, string> = { todo: "Todo", in_progress: "In progress", done: "Done" };
const TASK_STATUS_COLOR: Record<string, string> = {
  todo: "var(--muted)",
  in_progress: "var(--accent)",
  done: "var(--good)",
};

const INITIATIVE_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  on_hold: "On hold",
  completed: "Completed",
  archived: "Archived",
};
const INITIATIVE_STATUS_COLOR: Record<string, string> = {
  active: "var(--good)",
  on_hold: "var(--warn)",
  completed: "var(--accent)",
  archived: "var(--muted)",
};

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <Card className="!p-4">
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-2 text-xl font-semibold tracking-tight">{value}</div>
    </Card>
  );
}

export function Reports() {
  useEffect(() => {
    document.title = "Reports — Workspace";
  }, []);

  const q = useQuery({
    queryKey: qk.reports,
    queryFn: () => api.get<ReportsSummary>("/workspace/reports"),
  });

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const r = q.data!;
  const totalTasks = r.tasks_by_status.reduce((s, t) => s + t.n, 0);
  const openTasks = r.tasks_by_status.filter((t) => t.status !== "done").reduce((s, t) => s + t.n, 0);
  const totalInitiatives = r.initiatives_by_status.reduce((s, i) => s + i.n, 0);
  const completedLast14 = r.completed_by_day.reduce((s, d) => s + d.n, 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Initiatives" value={totalInitiatives} />
        <Tile label="Total tasks" value={totalTasks} />
        <Tile label="Open tasks" value={openTasks} />
        <Tile label="Completed (14d)" value={completedLast14} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHead title="Tasks by status" />
          <HorizontalBars
            bars={r.tasks_by_status.map((t) => ({
              label: TASK_STATUS_LABEL[t.status] ?? t.status,
              value: t.n,
              color: TASK_STATUS_COLOR[t.status] ?? "var(--accent)",
            }))}
          />
        </Card>

        <Card>
          <CardHead title="Initiatives by status" />
          <HorizontalBars
            bars={r.initiatives_by_status.map((i) => ({
              label: INITIATIVE_STATUS_LABEL[i.status] ?? i.status,
              value: i.n,
              color: INITIATIVE_STATUS_COLOR[i.status] ?? "var(--accent)",
            }))}
          />
        </Card>

        <Card>
          <CardHead title="Team workload" hint="Open (not-done) tasks per assignee" />
          {r.workload.length === 0 ? (
            <EmptyState title="No open tasks are assigned yet" />
          ) : (
            <HorizontalBars
              bars={r.workload.map((w) => ({
                label: w.full_name || w.email,
                value: w.n,
                color: "var(--accent)",
              }))}
            />
          )}
        </Card>

        <Card>
          <CardHead title="Completed tasks" hint="Last 14 days" />
          {r.completed_by_day.length === 0 ? (
            <EmptyState title="No tasks completed in this window" />
          ) : (
            <TrendBars data={r.completed_by_day} />
          )}
        </Card>
      </div>
    </div>
  );
}

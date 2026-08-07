/**
 * Watcher diagnostics: the agent's full local health snapshot, as last
 * reported to `/admin/systems/:id/health` — scan counts, WebSocket state,
 * offline queue depth, and any data-validation issues it found. Distinct
 * from the Status/Scan activity columns on the Systems table, which are a
 * curated, always-fresh subset; this is the deeper, slower-cadence picture
 * (pushed roughly every 5 minutes, or on demand via "Health check").
 *
 * Embedded inside SystemCommandsPanel as a collapsible section rather than
 * its own modal, so triggering a command and watching its effect on
 * diagnostics stays in one place.
 */

import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { AgentHealthSnapshot, SystemRow } from "../api/types";
import { fmtRelative } from "../lib/format";
import { Badge, ErrorState, LoadingState } from "./ui";

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
      <div className="text-2xs text-muted">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-ink">{value}</div>
    </div>
  );
}

export function SystemDiagnosticsPanel({ system }: { system: SystemRow }) {
  const health = useQuery({
    queryKey: qk.systemHealth(system.system_id),
    queryFn: () => api.get<AgentHealthSnapshot>(`/admin/systems/${system.system_id}/health`),
    refetchInterval: 15_000,
  });

  if (health.isLoading) return <LoadingState />;
  if (health.isError) return <ErrorState error={health.error} onRetry={() => health.refetch()} />;

  const h = health.data;
  if (!h || !h.recorded_at) {
    return (
      <p className="text-sm text-muted">
        No diagnostics reported yet — they arrive with the agent's next health push,
        or immediately after a "Health check" command.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Scans completed" value={h.scans_completed} />
        <Stat label="Scans failed" value={h.scans_failed} />
        <Stat
          label="WebSocket"
          value={
            h.ws_connected ? (
              <Badge tone="good">Connected</Badge>
            ) : (
              <Badge tone="neutral">Not connected</Badge>
            )
          }
        />
        <Stat label="Reconnect attempts" value={h.ws_reconnect_attempts} />
        <Stat label="Offline queue depth" value={h.offline_queue_depth} />
        <Stat label="Active sessions" value={h.active_sessions} />
        <Stat label="Last scan" value={fmtRelative(h.last_scan_at)} />
        <Stat label="PID" value={h.pid ?? "—"} />
        <Stat label="Reported" value={fmtRelative(h.recorded_at)} />
      </div>

      {h.last_scan_error && (
        <div className="rounded-lg border border-critical-weak bg-critical-weak px-3 py-2 text-sm text-critical">
          Last scan error: {h.last_scan_error}
        </div>
      )}

      <div>
        <div className="mb-1.5 text-xs font-semibold text-ink-2">Validation issues</div>
        {h.validation_issues.length === 0 ? (
          <p className="text-sm text-muted">No validation issues reported.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {h.validation_issues.map((issue, i) => (
              <li
                key={i}
                className="rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm text-ink-2"
              >
                {issue}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Per-system agent controls: quick actions (scan/pause/resume), a remote
 * config push, and the command history/ack trail — everything the
 * `/admin/systems/:id/commands` endpoints expose. Opened from the Systems
 * table; see Systems.tsx.
 *
 * Every button here queues one command (POST) rather than mutating the
 * agent directly — the agent picks it up on its next check-in (REST or WS)
 * and acks back, so `status` on each history row is the real outcome, not
 * just "the request was sent".
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { AgentCommand, CommandAction, SetConfigPayload, SystemRow } from "../api/types";
import { fmtRelative } from "../lib/format";
import { SystemDiagnosticsPanel } from "./SystemDiagnosticsPanel";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Modal,
  Table,
  Td,
  Th,
  useToast,
} from "./ui";

/**
 * Why a queued command won't run yet, keyed by the same graded health the
 * Systems table already shows. The agent runs continuously now, so any of
 * these mean something's actually wrong (or it was stopped on purpose) —
 * not the normal resting state.
 */
/**
 * The one thing worth repeating for every stuck-agent state: a queued
 * command (including Restart) only runs once the agent checks in on its own,
 * so it cannot unstick a genuinely hung process. `meterhouse stop` on the PC
 * itself kills it directly by PID and works fully offline; the Scheduled
 * Task supervisor then relaunches the daemon within about a minute.
 */
function RunStopLocally() {
  return (
    <>
      On that PC, run <code className="rounded bg-surface-2 px-1 py-0.5">meterhouse stop</code> —
      it kills the stuck process directly and the agent relaunches itself within about a minute.
      Queued commands here (including Restart) only run once the agent checks in on its own, so
      they can't unstick a genuinely hung process.
    </>
  );
}

const NOT_RUNNING_REASON: Partial<Record<SystemRow["health"], ReactNode>> = {
  dormant:
    "This PC's agent was stopped deliberately (a Stop command, or uninstalled). Queued " +
    "commands run once it's started again — via a Restart command, the scheduled task, " +
    "or a reboot.",
  late: "This PC hasn't checked in recently, so a queued command may sit pending for a while " +
    "before it's picked up.",
  stalled: (
    <>
      This PC's agent went quiet without checking in again. <RunStopLocally />
    </>
  ),
  dead: (
    <>
      This PC hasn't been heard from in over a day. <RunStopLocally /> If it's not installed at
      all, re-run the connect command instead.
    </>
  ),
  never: "This PC has never successfully checked in, so nothing is listening for queued " +
    "commands yet — finish setup on that machine first.",
};

function statusBadge(status: AgentCommand["status"]) {
  if (status === "acked") return <Badge tone="good">Acked</Badge>;
  if (status === "failed") return <Badge tone="critical">Failed</Badge>;
  // Terminal, not "still waiting" — pause/resume/stop/restart ack as skipped
  // when there's no running daemon loop to apply them to (e.g. a scheduled
  // one-shot sync). Falling through to "Pending" here would read as stuck.
  if (status === "skipped") return <Badge tone="neutral">Skipped</Badge>;
  return <Badge tone="neutral">Pending</Badge>;
}

const ACTION_LABEL: Record<CommandAction, string> = {
  scan_now: "Scan now",
  pause: "Pause",
  resume: "Resume",
  stop: "Stop scan",
  set_config: "Config push",
  force_sync: "Force sync",
  refresh_data: "Refresh data",
  restart: "Restart agent",
  health_check: "Health check",
};

export function SystemCommandsPanel({
  system,
  onClose,
}: {
  system: SystemRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [scanInterval, setScanInterval] = useState("");

  const history = useQuery({
    queryKey: qk.commands(system.system_id),
    queryFn: () => api.get<AgentCommand[]>(`/admin/systems/${system.system_id}/commands`),
    refetchInterval: 10_000, // short poll while the panel is open, to show acks land
  });

  const enqueue = useMutation({
    mutationFn: (input: { action: CommandAction; payload?: SetConfigPayload }) =>
      api.post<AgentCommand>(`/admin/systems/${system.system_id}/commands`, {
        action: input.action,
        payload: input.payload ?? {},
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.commands(system.system_id) });
      toast.push("Command queued — the agent picks it up on its next check-in.");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const pushInterval = () => {
    const seconds = Number(scanInterval);
    if (!Number.isInteger(seconds) || seconds < 5) {
      toast.push("Scan interval must be a whole number of at least 5 seconds.", "error");
      return;
    }
    enqueue.mutate({ action: "set_config", payload: { scan_interval_seconds: seconds } });
    setScanInterval("");
  };

  const toggle = (field: keyof SetConfigPayload, value: boolean) =>
    enqueue.mutate({ action: "set_config", payload: { [field]: value } });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Agent controls — ${system.display_name}`}
      hint="Commands are queued for delivery, not applied instantly — the agent acks once it has actually run them."
    >
      <div className="flex flex-col gap-5">
        {NOT_RUNNING_REASON[system.health] && (
          <Alert tone="info" title="Agent not currently running">
            {NOT_RUNNING_REASON[system.health]}
          </Alert>
        )}

        <div>
          <div className="mb-2 text-xs font-semibold text-ink-2">Quick actions</div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              loading={enqueue.isPending && enqueue.variables?.action === "scan_now"}
              onClick={() => enqueue.mutate({ action: "scan_now" })}
            >
              Scan now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={enqueue.isPending && enqueue.variables?.action === "pause"}
              onClick={() => enqueue.mutate({ action: "pause" })}
            >
              Pause
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={enqueue.isPending && enqueue.variables?.action === "resume"}
              onClick={() => enqueue.mutate({ action: "resume" })}
            >
              Resume
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={enqueue.isPending && enqueue.variables?.action === "stop"}
              onClick={() => enqueue.mutate({ action: "stop" })}
            >
              Stop scan
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={enqueue.isPending && enqueue.variables?.action === "force_sync"}
              onClick={() => enqueue.mutate({ action: "force_sync" })}
            >
              Force sync
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={enqueue.isPending && enqueue.variables?.action === "refresh_data"}
              onClick={() => enqueue.mutate({ action: "refresh_data" })}
            >
              Refresh data
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={enqueue.isPending && enqueue.variables?.action === "restart"}
              onClick={() => enqueue.mutate({ action: "restart" })}
            >
              Restart agent
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={enqueue.isPending && enqueue.variables?.action === "health_check"}
              onClick={() => {
                enqueue.mutate({ action: "health_check" });
                qc.invalidateQueries({ queryKey: qk.systemHealth(system.system_id) });
              }}
            >
              Health check
            </Button>
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold text-ink-2">
            Configuration refresh
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_auto] sm:items-end">
            <Field label="Scan interval (seconds)" hint="Minimum 5.">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={5}
                  value={scanInterval}
                  onChange={(e) => setScanInterval(e.target.value)}
                  placeholder="e.g. 60"
                />
              )}
            </Field>
            <Button
              size="sm"
              disabled={!scanInterval}
              loading={
                enqueue.isPending && enqueue.variables?.payload?.scan_interval_seconds !== undefined
              }
              onClick={pushInterval}
            >
              Update interval
            </Button>
          </div>

          <div className="mt-3 flex flex-col gap-2">
            {(
              [
                ["ws_enabled", "Real-time WebSocket push", "restart required to take effect"],
                ["session_titles_enabled", "Session titles", null],
                ["account_reporting_enabled", "Claude account reporting", null],
              ] as const
            ).map(([field, label, note]) => (
              <div key={field} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  {label}
                  {note && <span className="ml-1.5 text-xs text-muted">({note})</span>}
                </span>
                <div className="flex gap-1.5">
                  <Button size="sm" variant="subtle" onClick={() => toggle(field, true)}>
                    On
                  </Button>
                  <Button size="sm" variant="subtle" onClick={() => toggle(field, false)}>
                    Off
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <details className="rounded-xl border border-line bg-surface-2 px-4 py-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink-2">
            Diagnostics
          </summary>
          <div className="mt-3">
            <SystemDiagnosticsPanel system={system} />
          </div>
        </details>

        <div>
          <div className="mb-2 text-xs font-semibold text-ink-2">Command history</div>
          {history.isLoading ? (
            <LoadingState />
          ) : history.isError ? (
            <ErrorState error={history.error} onRetry={() => history.refetch()} />
          ) : (history.data?.length ?? 0) === 0 ? (
            <EmptyState title="No commands sent to this PC yet" />
          ) : (
            <Table caption="Commands queued for this PC">
              <thead>
                <tr>
                  <Th>Action</Th>
                  <Th>Status</Th>
                  <Th>Queued</Th>
                  <Th>Acked</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {history.data!.map((c) => (
                  <tr key={c.id}>
                    <Td className="font-medium">{ACTION_LABEL[c.action]}</Td>
                    <Td>{statusBadge(c.status)}</Td>
                    <Td className="text-ink-2">{fmtRelative(c.created_at)}</Td>
                    <Td className="text-ink-2">{fmtRelative(c.acked_at)}</Td>
                    <Td className="text-ink-2">
                      <span className="block max-w-[16rem] truncate" title={c.ack_detail}>
                        {c.ack_detail || "—"}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </div>
    </Modal>
  );
}

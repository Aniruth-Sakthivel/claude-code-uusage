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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { AgentCommand, CommandAction, SetConfigPayload, SystemRow } from "../api/types";
import { fmtRelative } from "../lib/format";
import {
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

function statusBadge(status: AgentCommand["status"]) {
  if (status === "acked") return <Badge tone="good">Acked</Badge>;
  if (status === "failed") return <Badge tone="critical">Failed</Badge>;
  return <Badge tone="neutral">Pending</Badge>;
}

const ACTION_LABEL: Record<CommandAction, string> = {
  scan_now: "Scan now",
  pause: "Pause",
  resume: "Resume",
  set_config: "Config push",
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
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold text-ink-2">Push config</div>
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

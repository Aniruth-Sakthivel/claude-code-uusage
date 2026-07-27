/**
 * Connect a PC — the single place machines are added.
 *
 * Replaces three divergent implementations (this page, the Login setup card,
 * and the Admin Keys enroll card). Available to every role, since
 * `/connect/self` is not admin-gated; a developer who cannot administer
 * anything can still connect their own machine.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { SystemRow } from "../api/types";
import { ConnectPanel } from "../components/ConnectPanel";
import {
  Alert,
  Card,
  CardHead,
  ErrorState,
  Eyebrow,
  LoadingState,
  StatusPill,
  Table,
  Td,
  Th,
  useToast,
} from "../components/ui";
import { useRealtime } from "../context/RealtimeContext";
import { fmtRelative, fmtTokens } from "../lib/format";

/** Fallback if the WebSocket is unreachable/disabled — stop waiting quietly
 * after this long rather than forever; the row's own status still reflects
 * reality either way. */
const AWAIT_SYNC_TIMEOUT_MS = 10 * 60 * 1000;

export function Connect() {
  const toast = useToast();
  const qc = useQueryClient();
  const realtime = useRealtime();
  const [awaitingId, setAwaitingId] = useState<string | null>(null);
  const [justSyncedName, setJustSyncedName] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
  });

  useEffect(() => {
    document.title = "Connect a PC — ClaudeFleet";
  }, []);

  // Live path: the agent's first scan/sync broadcasts a system_updated event
  // over the dashboard WebSocket — fires within seconds of the install script
  // finishing, no polling needed.
  useEffect(() => {
    return realtime.onSystemUpdated((evt) => {
      if (evt.system_id !== awaitingId) return;
      qc.invalidateQueries({ queryKey: qk.systems }).then(() => {
        const target = qc
          .getQueryData<SystemRow[]>(qk.systems)
          ?.find((s) => s.system_id === evt.system_id);
        if (!target || target.never_synced) return;
        setJustSyncedName(target.display_name);
        toast.push(`${target.display_name} connected and synced successfully.`, "success");
        setAwaitingId(null);
        clearTimeout(timeoutRef.current);
      });
    });
  }, [awaitingId, realtime, qc, toast]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Eyebrow>Setup</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Connect a PC</h1>
        <p className="mt-1.5 max-w-2xl text-base text-muted">
          Run one command in PowerShell on the machine you want to track. The website
          only generates the setup instructions; the agent on that PC does the scan and
          sends data back to the dashboard every 15 minutes.
        </p>
      </div>

      <ConnectPanel
        systems={systems.data ?? []}
        onConnected={(systemId) => {
          setJustSyncedName(null);
          setAwaitingId(systemId);
          clearTimeout(timeoutRef.current);
          timeoutRef.current = setTimeout(() => setAwaitingId(null), AWAIT_SYNC_TIMEOUT_MS);
        }}
      />

      {justSyncedName && (
        <Alert tone="info" title="Connected">
          {justSyncedName} is now reporting usage to this dashboard.
        </Alert>
      )}

      <Card>
        <CardHead
          title="Your connected PCs"
          hint={systems.data ? `${systems.data.length} total` : undefined}
        />

        {systems.isLoading ? (
          <LoadingState />
        ) : systems.isError ? (
          <ErrorState error={systems.error} onRetry={() => systems.refetch()} />
        ) : systems.data!.length === 0 ? (
          <p className="py-6 text-center text-base text-muted">
            No PCs yet — connect your first one above.
          </p>
        ) : (
          <Table caption="Connected machines and their sync status">
            <thead>
              <tr>
                <Th>PC</Th>
                <Th>Status</Th>
                <Th>Last sync</Th>
                <Th align="right">Tokens</Th>
              </tr>
            </thead>
            <tbody>
              {systems.data!.map((s) => (
                <tr key={s.system_id}>
                  <Td>
                    <div className="font-medium">{s.display_name}</div>
                    {s.hostname && <div className="text-xs text-muted">{s.hostname}</div>}
                  </Td>
                  <Td>
                    <StatusPill status={s.status} neverSynced={s.never_synced} />
                  </Td>
                  <Td className="text-muted">
                    {s.never_synced ? "Waiting for first sync" : fmtRelative(s.last_sync_at)}
                  </Td>
                  <Td align="right" className="tnum font-semibold">
                    {fmtTokens(s.total_tokens)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

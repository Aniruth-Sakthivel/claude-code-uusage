/**
 * Connect a PC — the single place machines are added.
 *
 * Replaces three divergent implementations (this page, the Login setup card,
 * and the Admin Keys enroll card). Available to every role, since
 * `/connect/self` is not admin-gated; a developer who cannot administer
 * anything can still connect their own machine.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { SystemRow } from "../api/types";
import { ConnectPanel } from "../components/ConnectPanel";
import {
  Card,
  CardHead,
  ErrorState,
  Eyebrow,
  LoadingState,
  StatusPill,
  Table,
  Td,
  Th,
} from "../components/ui";
import { fmtRelative, fmtTokens } from "../lib/format";

export function Connect() {
  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
  });

  useEffect(() => {
    document.title = "Connect a PC — ClaudeFleet";
  }, []);

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

      <ConnectPanel systems={systems.data ?? []} />

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

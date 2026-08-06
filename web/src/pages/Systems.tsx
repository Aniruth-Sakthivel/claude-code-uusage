/** Systems list — every connected PC with its status and totals. */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { fleetKeys, qk } from "../api/queryKeys";
import type { SystemRow } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { ScanActivity } from "../components/ScanActivity";
import { SystemCommandsPanel } from "../components/SystemCommandsPanel";
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Eyebrow,
  Input,
  LoadingState,
  Pagination,
  StatusPill,
  Table,
  Td,
  Th,
  useToast,
} from "../components/ui";
import { fmtRelative, fmtTokens } from "../lib/format";
import { useTableControls } from "../lib/useTableControls";

/**
 * Worst first, so sorting descending puts what needs attention on top.
 * `dormant` sits with the healthy end: an agent that stopped because nobody is
 * using Claude Code is working correctly.
 */
const HEALTH_ORDER: SystemRow["health"][] = [
  "dead",
  "stalled",
  "late",
  "never",
  "dormant",
  "healthy",
];

/**
 * What each status means, and — more usefully — what to do about it.
 *
 * The vocabulary is not self-evident any more. "Idle" reads as a problem until
 * you know the agent is *meant* to stop between sessions, and the difference
 * between Idle and Not running is the difference between "nothing to do" and
 * "go fix that PC". Spelling it out on the page beats leaving it to a tooltip.
 */
function StatusLegend() {
  const items: { health: SystemRow["health"]; means: string }[] = [
    { health: "healthy", means: "In a Claude Code session and reporting." },
    { health: "dormant", means: "Stopped because no session is open. Nothing to do." },
    { health: "late", means: "Missed a check-in — usually asleep or offline." },
    { health: "stalled", means: "Went quiet mid-session without stopping cleanly." },
    { health: "dead", means: "No contact for over a day. Re-run the connect command." },
    { health: "never", means: "Enrolled but has never reported. Finish setup on that PC." },
  ];

  return (
    <details className="rounded-xl border border-line bg-surface-2 px-4 py-3">
      <summary className="cursor-pointer text-sm font-semibold">
        What do these statuses mean?
      </summary>
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {items.map((i) => (
          <div key={i.health} className="flex items-baseline gap-2">
            <dt className="shrink-0">
              <StatusPill health={i.health} status="" />
            </dt>
            <dd className="text-sm text-muted">{i.means}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function Systems() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can("manage_systems");

  const [pendingDelete, setPendingDelete] = useState<SystemRow | null>(null);
  const [managing, setManaging] = useState<SystemRow | null>(null);

  const q = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
    // A scan takes seconds. At the old 60s poll the "Scanning…" state was
    // usually over before the table ever saw it, which is precisely the moment
    // an admin is watching for.
    refetchInterval: 10_000,
  });

  const remove = useMutation({
    mutationFn: (systemId: string) => api.del(`/admin/systems/${systemId}`),
    onSuccess: () => {
      fleetKeys.forEach((key) => qc.invalidateQueries({ queryKey: key }));
      toast.push("System removed.");
      setPendingDelete(null);
    },
    onError: (e: Error) => {
      toast.push(e.message, "error");
      setPendingDelete(null);
    },
  });

  useEffect(() => {
    document.title = "Systems — Meterhouse";
  }, []);

  const table = useTableControls(q.data, {
    searchText: (s) => `${s.display_name} ${s.hostname ?? ""} ${s.owner ?? ""}`,
    sorters: {
      name: (a, b) => a.display_name.localeCompare(b.display_name),
      // Sorted by the graded health the column actually renders, not by the
      // binary online flag. Those disagree now: a machine that stopped
      // cleanly is "offline" by check-in age but shows as Idle, so sorting on
      // `status` buried healthy machines among genuinely broken ones.
      status: (a, b) => HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health),
      tracked: (a, b) => a.total_tokens - b.total_tokens,
      projects: (a, b) => a.projects - b.projects,
      // Never-synced machines sort as epoch 0, so they land at the bottom of
      // the default (most-recent-first) view rather than the top.
      sync: (a, b) =>
        new Date(a.last_sync_at ?? 0).getTime() - new Date(b.last_sync_at ?? 0).getTime(),
    },
    descFirst: ["tracked", "projects", "sync", "status"],
    initialSortKey: "sync",
    initialSortDir: "desc",
  });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Eyebrow>Fleet</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Systems</h1>
        <p className="mt-1.5 max-w-3xl text-base text-muted">
          Every PC reporting usage, with its live status. The agent runs only while
          someone has a Claude Code session open, so most machines sit at{" "}
          <span className="font-medium text-ink-2">Idle</span> — that is healthy, not a
          fault.
        </p>
      </div>

      <StatusLegend />

      <Card>
        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data!.length === 0 ? (
          <EmptyState
            title="No systems visible"
            hint="Connect a PC, or ask an administrator to assign you one."
            action={
              <Link to="/connect">
                <Button size="sm">Connect a PC</Button>
              </Link>
            }
          />
        ) : (
          <>
            <div className="mb-3">
              <Input
                type="search"
                placeholder="Search by name, hostname, or owner…"
                value={table.query}
                onChange={(e) => table.setQuery(e.target.value)}
                aria-label="Search systems"
              />
            </div>
            {table.total === 0 ? (
              <EmptyState title="No systems match your search" />
            ) : (
              <Table caption="Systems with status, owner and tracked usage">
                <thead>
                  <tr>
                    <Th
                      sortDir={table.sortKey === "name" ? table.sortDir : null}
                      onSort={() => table.toggleSort("name")}
                    >
                      PC
                    </Th>
                    <Th
                      sortDir={table.sortKey === "status" ? table.sortDir : null}
                      onSort={() => table.toggleSort("status")}
                    >
                      Status
                    </Th>
                    <Th>Scan activity</Th>
                    <Th>Owner</Th>
                    <Th>Environment</Th>
                    <Th
                      sortDir={table.sortKey === "sync" ? table.sortDir : null}
                      onSort={() => table.toggleSort("sync")}
                    >
                      Last sync
                    </Th>
                    <Th
                      align="right"
                      sortDir={table.sortKey === "tracked" ? table.sortDir : null}
                      onSort={() => table.toggleSort("tracked")}
                    >
                      Tracked
                    </Th>
                    <Th
                      align="right"
                      sortDir={table.sortKey === "projects" ? table.sortDir : null}
                      onSort={() => table.toggleSort("projects")}
                    >
                      Projects
                    </Th>
                    {canManage && <Th align="right">Actions</Th>}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((s) => (
                <tr key={s.system_id}>
                  <Td>
                    <div className="font-semibold">{s.display_name}</div>
                    <div className="text-xs text-muted">{s.hostname || "—"}</div>
                  </Td>
                  <Td>
                    <StatusPill status={s.status} neverSynced={s.never_synced} health={s.health} reason={s.reason} />
                    {s.active_sessions > 0 && (
                      // The reason the agent is running at all. Without it the
                      // row says "Working" with nothing to say what it is
                      // working on.
                      <div className="text-xs text-muted">
                        {s.active_sessions} session{s.active_sessions === 1 ? "" : "s"} open
                      </div>
                    )}
                  </Td>
                  <Td>
                    <ScanActivity scan={s} neverReported={s.never_synced} />
                  </Td>
                  <Td className="text-ink-2">{s.owner || "—"}</Td>
                  <Td className="text-ink-2">{s.environment || "—"}</Td>
                  <Td className="tnum text-ink-2">
                    {s.never_synced ? "never" : fmtRelative(s.last_sync_at)}
                  </Td>
                  <Td align="right" className="tnum font-semibold">
                    {fmtTokens(s.total_tokens)}
                  </Td>
                  <Td align="right" className="tnum text-ink-2">
                    {s.projects}
                  </Td>
                  {canManage && (
                    <Td align="right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setManaging(s)}
                          aria-label={`Agent controls for ${s.display_name}`}
                        >
                          Agent controls
                        </Button>
                        <Button
                          size="sm"
                          variant="subtle"
                          onClick={() => setPendingDelete(s)}
                          aria-label={`Remove ${s.display_name}`}
                        >
                          Remove
                        </Button>
                      </div>
                    </Td>
                  )}
                </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <Pagination
              page={table.page}
              pageCount={table.pageCount}
              total={table.total}
              pageSize={table.pageSize}
              onPage={table.setPage}
            />
          </>
        )}
      </Card>

      {managing && <SystemCommandsPanel system={managing} onClose={() => setManaging(null)} />}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Remove ${pendingDelete?.display_name}?`}
        body="The PC, its API keys, and all usage data collected from it are deleted permanently. This cannot be undone — reconnecting later creates a new system with fresh history."
        confirmLabel="Remove system"
        destructive
        busy={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.system_id)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

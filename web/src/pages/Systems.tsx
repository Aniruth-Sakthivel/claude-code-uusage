/** Systems list — every connected PC with its status and totals. */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { fleetKeys, qk } from "../api/queryKeys";
import type { SystemRow } from "../api/types";
import { useAuth } from "../auth/AuthContext";
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

export function Systems() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can("manage_systems");

  const [pendingDelete, setPendingDelete] = useState<SystemRow | null>(null);

  const q = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
    refetchInterval: 60_000,
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
      status: (a, b) => Number(a.status === "online") - Number(b.status === "online"),
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
        <p className="mt-1.5 text-base text-muted">
          Every PC reporting usage, with its live status.
        </p>
      </div>

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
                    <StatusPill status={s.status} neverSynced={s.never_synced} />
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
                      <Button
                        size="sm"
                        variant="subtle"
                        onClick={() => setPendingDelete(s)}
                        aria-label={`Remove ${s.display_name}`}
                      >
                        Remove
                      </Button>
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

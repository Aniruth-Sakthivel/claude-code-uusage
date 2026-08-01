/**
 * Audit log. Records who did what, and never contains secrets, prompts,
 * responses, or source code.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { AuditRow } from "../api/types";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Eyebrow,
  Input,
  LoadingState,
  Pagination,
  Table,
  Td,
  Th,
} from "../components/ui";
import { fmtRelative } from "../lib/format";
import { useTableControls } from "../lib/useTableControls";

/** Destructive or security-relevant actions stand out. */
function toneFor(action: string): "neutral" | "accent" | "critical" {
  if (/revoked|deleted/.test(action)) return "critical";
  if (/created|invited|rotated|connected/.test(action)) return "accent";
  return "neutral";
}

export function AdminAudit() {
  const q = useQuery({ queryKey: qk.audit, queryFn: () => api.get<AuditRow[]>("/admin/audit") });

  useEffect(() => {
    document.title = "Audit log — Meterhouse";
  }, []);

  const table = useTableControls(q.data, {
    searchText: (a) => `${a.actor_email} ${a.action} ${a.target ?? ""} ${a.detail ?? ""}`,
    sorters: {
      when: (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
      action: (a, b) => a.action.localeCompare(b.action),
      actor: (a, b) => a.actor_email.localeCompare(b.actor_email),
    },
    descFirst: ["when"],
    initialSortKey: "when",
    initialSortDir: "desc",
  });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Eyebrow>Admin</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1.5 text-base text-muted">
          Account, system, and key activity. Never contains secrets or conversation
          content.
        </p>
      </div>

      <Card>
        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data!.length === 0 ? (
          <EmptyState title="No activity recorded yet" />
        ) : (
          <>
            <div className="mb-3">
              <Input
                type="search"
                placeholder="Search by actor, action, target, or detail…"
                value={table.query}
                onChange={(e) => table.setQuery(e.target.value)}
                aria-label="Search audit log"
              />
            </div>
            {table.total === 0 ? (
              <EmptyState title="No activity matches your search" />
            ) : (
              <Table caption="Recent administrative activity">
                <thead>
                  <tr>
                    <Th
                      sortDir={table.sortKey === "when" ? table.sortDir : null}
                      onSort={() => table.toggleSort("when")}
                    >
                      When
                    </Th>
                    <Th
                      sortDir={table.sortKey === "action" ? table.sortDir : null}
                      onSort={() => table.toggleSort("action")}
                    >
                      Action
                    </Th>
                    <Th
                      sortDir={table.sortKey === "actor" ? table.sortDir : null}
                      onSort={() => table.toggleSort("actor")}
                    >
                      Actor
                    </Th>
                    <Th>Target</Th>
                    <Th>Detail</Th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((a) => (
                    <tr key={a.id}>
                      <Td className="whitespace-nowrap text-ink-2">{fmtRelative(a.at)}</Td>
                      <Td>
                        <Badge tone={toneFor(a.action)}>{a.action}</Badge>
                      </Td>
                      <Td className="text-ink-2">{a.actor_email}</Td>
                      <Td className="text-ink-2">{a.target || "—"}</Td>
                      <Td className="max-w-xs truncate text-muted">
                        <span title={a.detail || undefined}>{a.detail || "—"}</span>
                      </Td>
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
    </div>
  );
}

/**
 * Recent Claude Code sessions. Metadata only — session ids, models, timestamps
 * and token counts. Never prompts, responses, or code.
 */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { SessionRow, SystemRow } from "../api/types";
import {
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
import { fmtRelative, fmtTokens } from "../lib/format";
import { useTableControls } from "../lib/useTableControls";

export function Sessions() {
  const sessions = useQuery({
    queryKey: qk.sessions,
    queryFn: () => api.get<SessionRow[]>("/sessions"),
  });
  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
  });

  useEffect(() => {
    document.title = "Sessions — ClaudeFleet";
  }, []);

  const nameOf = new Map((systems.data ?? []).map((s) => [s.system_id, s.display_name]));

  const table = useTableControls(sessions.data, {
    searchText: (s) => `${s.project_name} ${nameOf.get(s.system_id) ?? ""} ${s.model ?? ""}`,
    sorters: {
      project: (a, b) => a.project_name.localeCompare(b.project_name),
      lastActive: (a, b) => new Date(a.last_ts).getTime() - new Date(b.last_ts).getTime(),
      input: (a, b) => a.input_tokens - b.input_tokens,
      output: (a, b) => a.output_tokens - b.output_tokens,
      total: (a, b) => a.total_tokens - b.total_tokens,
    },
    initialSortKey: "lastActive",
    initialSortDir: "desc",
  });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Eyebrow>Analytics</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="mt-1.5 text-base text-muted">
          Most recent Claude Code sessions. Metadata only — no conversation content is
          ever collected.
        </p>
      </div>

      <Card>
        {sessions.isLoading ? (
          <LoadingState />
        ) : sessions.isError ? (
          <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} />
        ) : sessions.data!.length === 0 ? (
          <EmptyState
            title="No sessions yet"
            hint="Sessions appear after a connected PC syncs."
          />
        ) : (
          <>
            <div className="mb-3">
              <Input
                type="search"
                placeholder="Search by project, PC, or model…"
                value={table.query}
                onChange={(e) => table.setQuery(e.target.value)}
                aria-label="Search sessions"
              />
            </div>
            {table.total === 0 ? (
              <EmptyState title="No sessions match your search" />
            ) : (
              <Table caption="Recent sessions with model and token usage">
                <thead>
                  <tr>
                    <Th
                      sortDir={table.sortKey === "project" ? table.sortDir : null}
                      onSort={() => table.toggleSort("project")}
                    >
                      Project
                    </Th>
                    <Th>PC</Th>
                    <Th>Model</Th>
                    <Th
                      sortDir={table.sortKey === "lastActive" ? table.sortDir : null}
                      onSort={() => table.toggleSort("lastActive")}
                    >
                      Last active
                    </Th>
                    <Th
                      align="right"
                      sortDir={table.sortKey === "input" ? table.sortDir : null}
                      onSort={() => table.toggleSort("input")}
                    >
                      In
                    </Th>
                    <Th
                      align="right"
                      sortDir={table.sortKey === "output" ? table.sortDir : null}
                      onSort={() => table.toggleSort("output")}
                    >
                      Out
                    </Th>
                    <Th
                      align="right"
                      sortDir={table.sortKey === "total" ? table.sortDir : null}
                      onSort={() => table.toggleSort("total")}
                    >
                      Total
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((s) => (
                    <tr key={`${s.system_id}:${s.session_id}`}>
                      <Td className="font-medium">{s.project_name}</Td>
                      <Td className="text-ink-2">
                        {nameOf.get(s.system_id) ?? s.system_id.slice(0, 8)}
                      </Td>
                      <Td className="text-ink-2">{s.model || "—"}</Td>
                      <Td className="tnum text-ink-2">{fmtRelative(s.last_ts)}</Td>
                      <Td align="right" className="tnum text-ink-2">
                        {fmtTokens(s.input_tokens)}
                      </Td>
                      <Td align="right" className="tnum text-ink-2">
                        {fmtTokens(s.output_tokens)}
                      </Td>
                      <Td align="right" className="tnum font-semibold">
                        {fmtTokens(s.total_tokens)}
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

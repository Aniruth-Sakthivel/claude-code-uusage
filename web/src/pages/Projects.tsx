/** Per-project usage. Metadata only — never file contents. */

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { Project, SystemRow } from "../api/types";
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
import { fmtTokens } from "../lib/format";
import { useTableControls } from "../lib/useTableControls";

export function Projects() {
  const projects = useQuery({
    queryKey: qk.projects,
    queryFn: () => api.get<Project[]>("/projects"),
  });
  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
  });

  useEffect(() => {
    document.title = "Projects — ClaudeFleet";
  }, []);

  const nameOf = new Map((systems.data ?? []).map((s) => [s.system_id, s.display_name]));

  const table = useTableControls(projects.data, {
    searchText: (p) => `${p.project_name} ${nameOf.get(p.system_id) ?? ""}`,
    sorters: {
      project: (a, b) => a.project_name.localeCompare(b.project_name),
      input: (a, b) => a.input_tokens - b.input_tokens,
      output: (a, b) => a.output_tokens - b.output_tokens,
      cache: (a, b) =>
        a.cache_read_tokens + a.cache_creation_tokens - (b.cache_read_tokens + b.cache_creation_tokens),
      sessions: (a, b) => a.sessions - b.sessions,
      total: (a, b) => a.total_tokens - b.total_tokens,
    },
    initialSortKey: "total",
    initialSortDir: "desc",
  });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Eyebrow>Analytics</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="mt-1.5 text-base text-muted">
          Token usage grouped by project directory, across your visible PCs.
        </p>
      </div>

      <Card>
        {projects.isLoading ? (
          <LoadingState />
        ) : projects.isError ? (
          <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
        ) : projects.data!.length === 0 ? (
          <EmptyState
            title="No project activity yet"
            hint="Projects appear once a connected PC syncs its transcripts."
          />
        ) : (
          <>
            <div className="mb-3">
              <Input
                type="search"
                placeholder="Search by project or PC…"
                value={table.query}
                onChange={(e) => table.setQuery(e.target.value)}
                aria-label="Search projects"
              />
            </div>
            {table.total === 0 ? (
              <EmptyState title="No projects match your search" />
            ) : (
              <Table caption="Projects ranked by tracked tokens">
                <thead>
                  <tr>
                    <Th
                      sortDir={table.sortKey === "project" ? table.sortDir : null}
                      onSort={() => table.toggleSort("project")}
                    >
                      Project
                    </Th>
                    <Th>PC</Th>
                    <Th
                      align="right"
                      sortDir={table.sortKey === "input" ? table.sortDir : null}
                      onSort={() => table.toggleSort("input")}
                    >
                      Input
                    </Th>
                    <Th
                      align="right"
                      sortDir={table.sortKey === "output" ? table.sortDir : null}
                      onSort={() => table.toggleSort("output")}
                    >
                      Output
                    </Th>
                    <Th
                      align="right"
                      sortDir={table.sortKey === "cache" ? table.sortDir : null}
                      onSort={() => table.toggleSort("cache")}
                    >
                      Cache
                    </Th>
                    <Th
                      align="right"
                      sortDir={table.sortKey === "sessions" ? table.sortDir : null}
                      onSort={() => table.toggleSort("sessions")}
                    >
                      Sessions
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
                  {table.rows.map((p) => (
                    <tr key={`${p.system_id}:${p.project_name}`}>
                      <Td className="font-medium">{p.project_name}</Td>
                      <Td className="text-ink-2">
                        {nameOf.get(p.system_id) ?? p.system_id.slice(0, 8)}
                      </Td>
                      <Td align="right" className="tnum text-ink-2">
                        {fmtTokens(p.input_tokens)}
                      </Td>
                      <Td align="right" className="tnum text-ink-2">
                        {fmtTokens(p.output_tokens)}
                      </Td>
                      <Td align="right" className="tnum text-ink-2">
                        {fmtTokens(p.cache_read_tokens + p.cache_creation_tokens)}
                      </Td>
                      <Td align="right" className="tnum text-ink-2">
                        {p.sessions}
                      </Td>
                      <Td align="right" className="tnum font-semibold">
                        {fmtTokens(p.total_tokens)}
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

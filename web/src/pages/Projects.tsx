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
  LoadingState,
  Table,
  Td,
  Th,
} from "../components/ui";
import { fmtTokens } from "../lib/format";

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
          <Table caption="Projects ranked by tracked tokens">
            <thead>
              <tr>
                <Th>Project</Th>
                <Th>PC</Th>
                <Th align="right">Input</Th>
                <Th align="right">Output</Th>
                <Th align="right">Cache</Th>
                <Th align="right">Sessions</Th>
                <Th align="right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {projects.data!.map((p) => (
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
      </Card>
    </div>
  );
}

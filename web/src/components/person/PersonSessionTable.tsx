/**
 * One person's session history: filters, a paginated table, and pager.
 * Self-contained — owns its own query and filter state — so both the Sessions
 * page's embedded panel and the admin User Details page's Sessions tab can
 * drop it in without threading state through a parent.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { qk } from "../../api/queryKeys";
import type { PersonProject, PersonSessionsResponse } from "../../api/types";
import {
  CardHead,
  EmptyState,
  ErrorState,
  LoadingState,
  Pagination,
  Select,
  Table,
  Td,
  Th,
} from "../ui";
import { fmtRelative, fmtTokens } from "../../lib/format";

/**
 * Time between a session's first and last activity.
 *
 * This is an *active span*, not time spent working — a session left open over
 * lunch counts the gap. Labelled accordingly rather than as "usage time",
 * which the transcripts cannot support.
 */
function fmtSpan(firstTs: string, lastTs: string): string {
  const ms = new Date(lastTs).getTime() - new Date(firstTs).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export function PersonSessionTable({
  personId,
  range,
  projects,
  showHeader = true,
}: {
  personId: number;
  range: string;
  /** For the project filter dropdown — pass the same list the Projects tab uses. */
  projects: PersonProject[];
  showHeader?: boolean;
}) {
  const [project, setProject] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);

  const sessions = useQuery({
    queryKey: qk.personSessions(personId, range, project, status, page),
    queryFn: () => {
      const params = new URLSearchParams({ range, page: String(page), pageSize: "20" });
      if (project) params.set("project", project);
      if (status) params.set("status", status);
      return api.get<PersonSessionsResponse>(`/people/${personId}/sessions?${params}`);
    },
  });

  return (
    <div>
      {showHeader && (
        <CardHead
          title="Session history"
          hint={sessions.data ? `${sessions.data.total} sessions` : undefined}
        />
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        <Select
          value={project}
          onChange={(e) => {
            setProject(e.target.value);
            setPage(0);
          }}
          aria-label="Filter by project"
          className="max-w-[16rem]"
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.project_name} value={p.project_name}>
              {p.project_name}
            </option>
          ))}
        </Select>
        <Select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(0);
          }}
          aria-label="Filter by session status"
          className="max-w-[12rem]"
        >
          <option value="">Any status</option>
          <option value="active">Active (last 30m)</option>
          <option value="idle">Idle</option>
        </Select>
      </div>

      {sessions.isLoading ? (
        <LoadingState />
      ) : sessions.isError ? (
        <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} />
      ) : (sessions.data?.sessions.length ?? 0) === 0 ? (
        <EmptyState
          title="No sessions in this window"
          hint="Try a wider date range, or clear the filters."
        />
      ) : (
        <>
          <Table caption="Sessions for the selected person">
            <thead>
              <tr>
                <Th>Session</Th>
                <Th>Project</Th>
                <Th>PC</Th>
                <Th>Last active</Th>
                <Th align="right">Span</Th>
                <Th align="right">Prompts</Th>
                <Th align="right">Tokens</Th>
              </tr>
            </thead>
            <tbody>
              {sessions.data!.sessions.map((s) => (
                <tr key={`${s.system_id}:${s.session_id}`}>
                  <Td>
                    {/* Title only exists when that machine opted into title
                        sync; otherwise fall back to a short session id. */}
                    <div className="font-semibold">
                      {s.title || <span className="text-muted">{s.session_id.slice(0, 8)}</span>}
                    </div>
                    <div className="text-xs text-muted">{s.model || "—"}</div>
                  </Td>
                  <Td className="text-ink-2">{s.project_name}</Td>
                  <Td className="text-ink-2">{s.system_name}</Td>
                  <Td className="tnum text-ink-2">{fmtRelative(s.last_ts)}</Td>
                  <Td align="right" className="tnum text-ink-2">
                    {fmtSpan(s.first_ts, s.last_ts)}
                  </Td>
                  <Td align="right" className="tnum text-ink-2">
                    {s.prompts === null ? "—" : s.prompts}
                  </Td>
                  <Td align="right" className="tnum font-semibold">
                    {fmtTokens(s.total_tokens)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <Pagination
            page={sessions.data!.page}
            pageCount={sessions.data!.page_count}
            total={sessions.data!.total}
            pageSize={sessions.data!.page_size}
            onPage={setPage}
          />
        </>
      )}
    </div>
  );
}

/**
 * The detail panel: one person's summary, projects, and session history.
 *
 * Sessions are fetched server-side per person, filtered and paged there. The
 * fleet-wide sessions endpoint caps at 200 rows, so paging here client-side
 * would hide someone's history behind other people's.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { PersonDetail as Detail, PersonSessionsResponse } from "../api/types";
import { ScanActivity } from "./ScanActivity";
import {
  Badge,
  Card,
  CardHead,
  EmptyState,
  ErrorState,
  LoadingState,
  Pagination,
  Select,
  StatusPill,
  Table,
  Td,
  Th,
} from "./ui";
import { fmtRelative, fmtTokens } from "../lib/format";

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

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="faceplate text-2xs text-muted">{label}</div>
      <div className="tnum mt-1 text-lg font-semibold text-ink">{value}</div>
      {hint && <div className="mt-0.5 text-2xs text-muted">{hint}</div>}
    </div>
  );
}

export function PersonDetailPanel({ personId, range }: { personId: number; range: string }) {
  const [project, setProject] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);

  const detail = useQuery({
    queryKey: qk.person(personId, range),
    queryFn: () => api.get<Detail>(`/people/${personId}?range=${range}`),
  });

  const sessions = useQuery({
    queryKey: qk.personSessions(personId, range, project, status, page),
    queryFn: () => {
      const params = new URLSearchParams({ range, page: String(page), pageSize: "20" });
      if (project) params.set("project", project);
      if (status) params.set("status", status);
      return api.get<PersonSessionsResponse>(`/people/${personId}/sessions?${params}`);
    },
  });

  if (detail.isLoading) {
    return (
      <Card>
        <LoadingState />
      </Card>
    );
  }
  if (detail.isError) {
    return (
      <Card>
        <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
      </Card>
    );
  }

  const person = detail.data!.person;
  const projects = detail.data!.projects;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight text-ink">
                {person.full_name || person.email}
              </h2>
              <Badge tone="neutral">{person.role}</Badge>
              {person.plan_label && (
                <Badge tone={person.plan_label.startsWith("Max") ? "accent" : "neutral"}>
                  {person.plan_label}
                </Badge>
              )}
            </div>
            <div className="mt-1 text-sm text-muted">{person.email}</div>
            {person.account_email && (
              <div className="mt-0.5 text-xs text-muted">
                Claude account: <span className="text-ink-2">{person.account_email}</span>
              </div>
            )}
          </div>
          <div className="flex flex-col items-end gap-2">
            <StatusPill status={person.status} />
            {/* Agent activity, not person activity: whether their usage is
                being collected right now, and when the next scan is due. */}
            {person.scan && (
              <div className="text-right">
                <ScanActivity scan={person.scan} neverReported={person.system_count === 0} />
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Tokens" value={fmtTokens(person.tokens_range)} hint={`${range} window`} />
          <Stat label="Today" value={fmtTokens(person.tokens_today)} />
          <Stat label="Sessions" value={String(person.sessions)} />
          <Stat
            label="Prompts"
            value={person.prompts === null ? "—" : String(person.prompts)}
            hint={person.prompts === null ? "not collected yet" : undefined}
          />
          <Stat label="Projects" value={String(projects.length)} />
          <Stat label="PCs" value={String(person.system_count)} />
          <Stat label="Last active" value={fmtRelative(person.last_active)} />
          <Stat label="Account" value={person.plan_label ?? "—"} />
        </div>
      </Card>

      {projects.length > 0 && (
        <Card>
          <CardHead title="Project activity" hint={`${projects.length} in this window`} />
          <div className="flex flex-col gap-2">
            {projects.slice(0, 6).map((p) => {
              const max = projects[0]?.total_tokens || 1;
              return (
                <div key={p.project_name} className="flex items-center gap-3">
                  <div className="w-40 shrink-0 truncate text-sm text-ink-2">{p.project_name}</div>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full bg-accent"
                      style={{ width: `${Math.max(2, (p.total_tokens / max) * 100)}%` }}
                    />
                  </div>
                  <div className="tnum w-16 shrink-0 text-right text-sm font-semibold">
                    {fmtTokens(p.total_tokens)}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card>
        <CardHead
          title="Session history"
          hint={sessions.data ? `${sessions.data.total} sessions` : undefined}
        />
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
      </Card>
    </div>
  );
}

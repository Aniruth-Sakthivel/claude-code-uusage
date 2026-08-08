/**
 * The detail panel: one person's summary, projects, and session history.
 *
 * A thin composition of the shared `person/` pieces (stat grid, project bars,
 * session table) — kept as its own component because the Sessions page's
 * master-detail layout needs exactly this bundle, while the admin User
 * Details page recomposes the same pieces into tabs instead.
 */

import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { PersonDetail as Detail } from "../api/types";
import { Avatar } from "./Avatar";
import { ScanActivity } from "./ScanActivity";
import { PersonProjectBarsCard } from "./person/PersonProjectBars";
import { PersonSessionTable } from "./person/PersonSessionTable";
import { PersonStatGrid } from "./person/PersonStatGrid";
import { Badge, Card, ErrorState, LoadingState, StatusPill } from "./ui";

export function PersonDetailPanel({ personId, range }: { personId: number; range: string }) {
  const detail = useQuery({
    queryKey: qk.person(personId, range),
    queryFn: () => api.get<Detail>(`/people/${personId}?range=${range}`),
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
          <div className="flex min-w-0 items-start gap-3">
            <Avatar
              label={person.full_name || person.email}
              src={person.avatar_url}
              size="md"
              presence={person.status}
            />
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

        <div className="mt-4">
          <PersonStatGrid person={person} projectCount={projects.length} range={range} />
        </div>
      </Card>

      {projects.length > 0 && (
        <Card>
          <PersonProjectBarsCard projects={projects} />
        </Card>
      )}

      <Card>
        <PersonSessionTable personId={personId} range={range} projects={projects} />
      </Card>
    </div>
  );
}

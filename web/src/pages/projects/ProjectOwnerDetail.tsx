/**
 * One owner's full project list — the drill-down target from a Projects grid
 * card, mirroring the admin User Details page's route-param pattern.
 */

import { useEffect, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";

import { api } from "../../api/client";
import { qk } from "../../api/queryKeys";
import type { Project, SystemRow } from "../../api/types";
import { Avatar } from "../../components/Avatar";
import { ProjectCard } from "../../components/projects/ProjectCard";
import { Card, EmptyState, ErrorState, Eyebrow, LoadingState } from "../../components/ui";
import { fmtTokens } from "../../lib/format";

export function ProjectOwnerDetail() {
  const params = useParams<{ owner: string }>();
  const owner = decodeURIComponent(params.owner ?? "");
  const isUnowned = owner === "No owner";

  useEffect(() => {
    document.title = `${owner} — Projects — Meterhouse`;
  }, [owner]);

  const projects = useQuery({
    queryKey: qk.projects,
    queryFn: () => api.get<Project[]>("/projects"),
  });
  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
  });

  const isLoading = projects.isLoading || systems.isLoading;
  const isError = projects.isError || systems.isError;

  const nameOf = new Map((systems.data ?? []).map((s) => [s.system_id, s.display_name]));
  const ownerOf = new Map((systems.data ?? []).map((s) => [s.system_id, s.owner]));

  const ownerProjects = useMemo(() => {
    return (projects.data ?? [])
      .filter((p) => (ownerOf.get(p.system_id) || "No owner") === owner)
      .map((p) => ({ ...p, pcName: nameOf.get(p.system_id) ?? p.system_id.slice(0, 8) }))
      .sort((a, b) => b.total_tokens - a.total_tokens);
  }, [projects.data, ownerOf, nameOf, owner]);

  const totalTokens = ownerProjects.reduce((sum, p) => sum + p.total_tokens, 0);
  const sessions = ownerProjects.reduce((sum, p) => sum + p.sessions, 0);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          to="/projects"
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Projects
        </Link>
        <Eyebrow>Analytics</Eyebrow>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          {isUnowned ? (
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-dashed border-line text-2xs text-muted">
              —
            </span>
          ) : (
            <Avatar label={owner} size="md" />
          )}
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{owner}</h1>
            <div className="mt-0.5 tnum text-sm text-muted">
              {fmtTokens(totalTokens)} tracked · {sessions} sessions
            </div>
          </div>
        </div>
      </div>

      {isLoading ? (
        <Card>
          <LoadingState />
        </Card>
      ) : isError ? (
        <Card>
          <ErrorState
            error={projects.error ?? systems.error}
            onRetry={() => {
              projects.refetch();
              systems.refetch();
            }}
          />
        </Card>
      ) : ownerProjects.length === 0 ? (
        <Card>
          <EmptyState title="No projects for this owner" />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ownerProjects.map((p) => (
            <ProjectCard key={`${p.system_id}:${p.project_name}`} project={p} pcName={p.pcName} />
          ))}
        </div>
      )}
    </div>
  );
}

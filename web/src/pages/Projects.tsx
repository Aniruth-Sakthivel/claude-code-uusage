/**
 * Projects, grouped by the PC owner running them — a card grid mirroring the
 * admin Users page. Each card is a drill-down into that owner's full project
 * list (`ProjectOwnerDetail`), not an inline expansion, so this page stays a
 * quick scan of who's using what.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { Project, SystemRow } from "../api/types";
import { OwnerCard, type OwnerGroupSummary } from "../components/projects/OwnerCard";
import { Card, EmptyState, ErrorState, Eyebrow, Input, LoadingState } from "../components/ui";

export function Projects() {
  const [query, setQuery] = useState("");

  const projects = useQuery({
    queryKey: qk.projects,
    queryFn: () => api.get<Project[]>("/projects"),
  });
  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
  });

  useEffect(() => {
    document.title = "Projects — Meterhouse";
  }, []);

  const ownerOf = new Map((systems.data ?? []).map((s) => [s.system_id, s.owner]));
  const nameOf = new Map((systems.data ?? []).map((s) => [s.system_id, s.display_name]));

  const groups: OwnerGroupSummary[] = useMemo(() => {
    const byOwner = new Map<string, OwnerGroupSummary>();
    for (const p of projects.data ?? []) {
      const owner = ownerOf.get(p.system_id) || "No owner";
      const group = byOwner.get(owner) ?? { owner, totalTokens: 0, sessions: 0, projectCount: 0 };
      group.totalTokens += p.total_tokens;
      group.sessions += p.sessions;
      group.projectCount += 1;
      byOwner.set(owner, group);
    }

    const q = query.trim().toLowerCase();
    const filtered = q
      ? [...byOwner.values()].filter((g) => {
          if (g.owner.toLowerCase().includes(q)) return true;
          return (projects.data ?? []).some(
            (p) =>
              (ownerOf.get(p.system_id) || "No owner") === g.owner &&
              (p.project_name.toLowerCase().includes(q) ||
                (nameOf.get(p.system_id) ?? "").toLowerCase().includes(q)),
          );
        })
      : [...byOwner.values()];

    // Heaviest owner first, "No owner" always last regardless of its total —
    // unassigned PCs are the exception to surface, not the headline.
    return filtered.sort((a, b) => {
      if (a.owner === "No owner") return 1;
      if (b.owner === "No owner") return -1;
      return b.totalTokens - a.totalTokens;
    });
  }, [projects.data, query, ownerOf, nameOf]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Eyebrow>Analytics</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Projects</h1>
        <p className="mt-1.5 text-base text-muted">
          Token usage grouped by who runs the PC — open a card for their full project list.
        </p>
      </div>

      {projects.isLoading ? (
        <Card>
          <LoadingState />
        </Card>
      ) : projects.isError ? (
        <Card>
          <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
        </Card>
      ) : projects.data!.length === 0 ? (
        <Card>
          <EmptyState
            title="No project activity yet"
            hint="Projects appear once a connected PC syncs its transcripts."
          />
        </Card>
      ) : (
        <>
          <Input
            type="search"
            placeholder="Search by owner, project, or PC…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search projects"
          />

          {groups.length === 0 ? (
            <Card>
              <EmptyState title="No owners match your search" />
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {groups.map((g) => (
                <OwnerCard key={g.owner} group={g} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

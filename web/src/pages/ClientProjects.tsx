/** Client portal: list of initiatives shared with this client account.
 * Reuses `GET /api/v1/initiatives` — the backend already scopes it to shared
 * initiatives only for the `client` role (see services/pm.ts `listInitiatives`). */

import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { Initiative } from "../api/types";
import { Badge, Card, EmptyState, ErrorState, LoadingState, Td, Table, Th } from "../components/ui";

export function ClientProjects() {
  useEffect(() => {
    document.title = "My Projects — Client Portal";
  }, []);

  const q = useQuery({ queryKey: qk.initiatives, queryFn: () => api.get<Initiative[]>("/initiatives") });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Projects</h1>
        <p className="mt-1.5 text-base text-muted">Progress on the work shared with you.</p>
      </div>

      <Card>
        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (q.data?.length ?? 0) === 0 ? (
          <EmptyState title="No projects shared with you yet" hint="Check back once your team shares progress." />
        ) : (
          <Table caption="Projects shared with you">
            <thead>
              <tr>
                <Th>Project</Th>
                <Th>Status</Th>
                <Th align="right">Open tasks</Th>
              </tr>
            </thead>
            <tbody>
              {q.data!.map((i) => (
                <tr key={i.id}>
                  <Td>
                    <Link to={`/portal/${i.id}`} className="font-semibold hover:text-accent">
                      {i.name}
                    </Link>
                  </Td>
                  <Td>
                    <Badge tone={i.status === "active" ? "good" : "neutral"}>{i.status.replace("_", " ")}</Badge>
                  </Td>
                  <Td align="right" className="tnum text-ink-2">
                    {i.open_task_count}
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

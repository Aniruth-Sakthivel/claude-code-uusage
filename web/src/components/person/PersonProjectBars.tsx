/**
 * A person's project activity. Bar-list mode (default) is used embedded in the
 * Overview panel, capped by `limit`; table mode renders every project, used by
 * the admin User Details page's Projects tab.
 */

import type { PersonProject } from "../../api/types";
import { fmtTokens } from "../../lib/format";
import { CardHead, EmptyState, Table, Td, Th } from "../ui";

export function PersonProjectBars({
  projects,
  limit,
  mode = "bars",
}: {
  projects: PersonProject[];
  limit?: number;
  mode?: "bars" | "table";
}) {
  if (projects.length === 0) {
    return <EmptyState title="No project activity in this window" />;
  }

  if (mode === "table") {
    return (
      <Table caption="Project activity for this person">
        <thead>
          <tr>
            <Th>Project</Th>
            <Th align="right">Sessions</Th>
            <Th align="right">Tokens</Th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.project_name}>
              <Td>{p.project_name}</Td>
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
    );
  }

  const shown = limit ? projects.slice(0, limit) : projects;
  const max = projects[0]?.total_tokens || 1;

  return (
    <div className="flex flex-col gap-2">
      {shown.map((p) => (
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
      ))}
    </div>
  );
}

/** Wraps the bars in the same Card+CardHead chrome the embedded panel used. */
export function PersonProjectBarsCard({ projects }: { projects: PersonProject[] }) {
  if (projects.length === 0) return null;
  return (
    <>
      <CardHead title="Project activity" hint={`${projects.length} in this window`} />
      <PersonProjectBars projects={projects} limit={6} />
    </>
  );
}

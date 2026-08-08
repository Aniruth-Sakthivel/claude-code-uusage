/**
 * One project's usage, as a card — no drill-down, everything worth knowing
 * about a project fits on the card itself.
 *
 * `owner` only renders when passed — the Projects page groups cards under a
 * per-owner section heading, so the card itself stays focused on the PC and
 * numbers rather than repeating who the group header already named.
 */

import { Avatar } from "../Avatar";
import { Card } from "../ui";
import { fmtTokens } from "../../lib/format";

export function ProjectCard({
  project,
  pcName,
  owner,
}: {
  project: {
    project_name: string;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    sessions: number;
  };
  pcName: string;
  /** Who runs this project's PC — the closest thing to a project "owner". */
  owner?: string;
}) {
  return (
    <Card className="h-full">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-ink">{project.project_name}</div>
        <div className="truncate text-xs text-muted">{pcName}</div>
      </div>

      {owner && (
        <div className="mt-3 flex items-center gap-2">
          <Avatar label={owner} />
          <span className="truncate text-xs text-ink-2">{owner}</span>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 text-center">
        <div className="rounded-lg bg-surface-2 py-2">
          <div className="tnum text-sm font-semibold text-ink">{project.sessions}</div>
          <div className="text-2xs text-muted">sessions</div>
        </div>
        <div className="rounded-lg bg-surface-2 py-2">
          <div className="tnum text-sm font-semibold text-ink">{fmtTokens(project.total_tokens)}</div>
          <div className="text-2xs text-muted">total tokens</div>
        </div>
      </div>

      <div className="mt-2 tnum text-2xs text-muted">
        In {fmtTokens(project.input_tokens)} · Out {fmtTokens(project.output_tokens)} · Cache{" "}
        {fmtTokens(project.cache_read_tokens + project.cache_creation_tokens)}
      </div>
    </Card>
  );
}

/**
 * One owner's card in the Projects grid — a drill-down entry point, styled to
 * match the admin Users card (`UserCard`). Clicking opens that owner's full
 * project list on its own page, the same way a user card opens User Details.
 */

import { Link } from "react-router-dom";

import { Avatar } from "../Avatar";
import { Card } from "../ui";
import { fmtTokens } from "../../lib/format";

export interface OwnerGroupSummary {
  owner: string;
  totalTokens: number;
  sessions: number;
  projectCount: number;
}

export function OwnerCard({ group }: { group: OwnerGroupSummary }) {
  const isUnowned = group.owner === "No owner";

  return (
    <Link to={`/projects/${encodeURIComponent(group.owner)}`} className="block">
      <Card className="h-full transition hover:border-accent/40">
        <div className="flex items-center gap-2.5">
          {isUnowned ? (
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-dashed border-line text-2xs text-muted">
              —
            </span>
          ) : (
            <Avatar label={group.owner} size="md" />
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ink">{group.owner}</div>
            <div className="truncate text-xs text-muted">
              {group.projectCount} project{group.projectCount === 1 ? "" : "s"}
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-center">
          <div className="rounded-lg bg-surface-2 py-2">
            <div className="tnum text-sm font-semibold text-ink">{fmtTokens(group.totalTokens)}</div>
            <div className="text-2xs text-muted">tokens</div>
          </div>
          <div className="rounded-lg bg-surface-2 py-2">
            <div className="tnum text-sm font-semibold text-ink">{group.sessions}</div>
            <div className="text-2xs text-muted">sessions</div>
          </div>
        </div>
      </Card>
    </Link>
  );
}

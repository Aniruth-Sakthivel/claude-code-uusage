/**
 * A lightweight per-person card for the fleet-wide "Everyone" glance on the
 * Sessions page. Deliberately lighter than `UserCard` — no role/status
 * badges, no projects count — this is a read-only summary, not an admin
 * entity.
 */

import type { PersonRow } from "../../api/types";
import { Avatar } from "../Avatar";
import { Card } from "../ui";
import { fmtRelative, fmtTokens } from "../../lib/format";

export function PersonMiniCard({ person: p }: { person: PersonRow }) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2.5">
        <Avatar label={p.full_name || p.email} src={p.avatar_url} presence={p.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink">{p.full_name || p.email}</div>
          <div className="tnum mt-0.5 flex items-center gap-1.5 text-2xs text-muted">
            <span>{fmtTokens(p.tokens_range)}</span>
            <span aria-hidden>·</span>
            <span>{p.sessions} sessions</span>
            <span aria-hidden>·</span>
            <span>{fmtRelative(p.last_active)}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

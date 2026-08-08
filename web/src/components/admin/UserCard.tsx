/**
 * One user's card in the admin grid — a pure drill-down entry point. No
 * inline actions here; role/status/delete/name edits all live on the User
 * Details page (`AdminUserActionsPanel`) to keep the grid scannable.
 */

import { Link } from "react-router-dom";

import { Avatar } from "../Avatar";
import { Badge, Card } from "../ui";
import { fmtRelative, fmtTokens } from "../../lib/format";

export interface AdminUserCard {
  id: number;
  email: string;
  full_name: string;
  avatar_url: string | null;
  role: string;
  is_active: boolean;
  status: "online" | "offline";
  tokens_range: number;
  sessions: number;
  projects: number;
  last_active: string | null;
}

export function UserCard({ user }: { user: AdminUserCard }) {
  return (
    <Link to={`/admin/users/${user.id}`} className="block">
      <Card className="h-full transition hover:border-accent/40">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar
              label={user.full_name || user.email}
              src={user.avatar_url}
              size="md"
              presence={user.status}
            />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-ink">
                {user.full_name || user.email}
              </div>
              <div className="truncate text-xs text-muted">{user.email}</div>
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">{user.role}</Badge>
          {user.is_active ? (
            <Badge tone="good">Active</Badge>
          ) : (
            <Badge tone="critical">Disabled</Badge>
          )}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-surface-2 py-2">
            <div className="tnum text-sm font-semibold text-ink">{fmtTokens(user.tokens_range)}</div>
            <div className="text-2xs text-muted">tokens</div>
          </div>
          <div className="rounded-lg bg-surface-2 py-2">
            <div className="tnum text-sm font-semibold text-ink">{user.sessions}</div>
            <div className="text-2xs text-muted">sessions</div>
          </div>
          <div className="rounded-lg bg-surface-2 py-2">
            <div className="tnum text-sm font-semibold text-ink">{user.projects}</div>
            <div className="text-2xs text-muted">projects</div>
          </div>
        </div>

        <div className="mt-2 text-2xs text-muted">Last active {fmtRelative(user.last_active)}</div>
      </Card>
    </Link>
  );
}

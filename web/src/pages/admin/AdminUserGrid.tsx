/**
 * Admin users, as a card grid. Replaces the old flat table: each card is a
 * drill-down into that person's dedicated details page rather than a row of
 * inline controls.
 *
 * Data is two existing queries merged client-side by id: `/admin/users` for
 * the admin-authoritative fields (role, system_ids, is_active — never exposed
 * on `/people`, which non-admin roles can also call), and `/people` for the
 * usage summary (tokens, sessions, projects, presence, avatar).
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";

import { api } from "../../api/client";
import { qk } from "../../api/queryKeys";
import type { PeopleResponse, SystemRow, User } from "../../api/types";
import { InviteUserModal } from "../../components/admin/InviteUserModal";
import { UserCard, type AdminUserCard } from "../../components/admin/UserCard";
import { ROLES } from "../../lib/roles";
import {
  Button,
  EmptyState,
  ErrorState,
  Eyebrow,
  Input,
  LoadingState,
  Select,
} from "../../components/ui";

const RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
];

export function AdminUserGrid() {
  useEffect(() => {
    document.title = "Users & roles — Meterhouse";
  }, []);

  const [range, setRange] = useState("30d");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);

  const users = useQuery({ queryKey: qk.users, queryFn: () => api.get<User[]>("/admin/users") });
  const people = useQuery({
    queryKey: qk.people(range),
    queryFn: () => api.get<PeopleResponse>(`/people?range=${range}`),
  });
  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
  });

  const cards: AdminUserCard[] = useMemo(() => {
    if (!users.data) return [];
    const byId = new Map((people.data?.people ?? []).map((p) => [p.id, p]));
    return users.data.map((u) => {
      const p = byId.get(u.id);
      return {
        id: u.id,
        email: u.email,
        full_name: u.full_name,
        avatar_url: u.avatar_url,
        role: u.role,
        is_active: u.is_active,
        status: p?.status ?? "offline",
        tokens_range: p?.tokens_range ?? 0,
        sessions: p?.sessions ?? 0,
        projects: p?.projects ?? 0,
        last_active: p?.last_active ?? null,
      };
    });
  }, [users.data, people.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards.filter((c) => {
      if (roleFilter && c.role !== roleFilter) return false;
      if (statusFilter === "active" && !c.is_active) return false;
      if (statusFilter === "disabled" && c.is_active) return false;
      if (!q) return true;
      return c.email.toLowerCase().includes(q) || c.full_name.toLowerCase().includes(q);
    });
  }, [cards, query, roleFilter, statusFilter]);

  const isLoading = users.isLoading || people.isLoading;
  const isError = users.isError || people.isError;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Eyebrow>Admin</Eyebrow>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Users &amp; roles</h1>
          <p className="mt-1.5 text-base text-muted">
            Every person, at a glance — open a card for their projects, sessions, and usage.
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>
          <UserPlus size={16} /> Invite someone
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search people…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search people by name or email"
          className="max-w-xs"
        />
        <Select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          aria-label="Filter by role"
          className="max-w-[10rem]"
        >
          <option value="">Any role</option>
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </Select>
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
          className="max-w-[10rem]"
        >
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
        </Select>
        <div
          role="tablist"
          aria-label="Time range"
          className="ml-auto inline-flex rounded-full border border-line bg-surface-2 p-1"
        >
          {RANGES.map((r) => (
            <button
              key={r.id}
              role="tab"
              aria-selected={range === r.id}
              onClick={() => setRange(r.id)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                range === r.id
                  ? "bg-surface text-ink shadow-[var(--shadow)]"
                  : "text-ink-2 hover:text-ink"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState error={users.error ?? people.error} onRetry={() => { users.refetch(); people.refetch(); }} />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={cards.length === 0 ? "No users yet" : "No one matches these filters"}
          hint={cards.length === 0 ? "Invite someone to get started." : undefined}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((c) => (
            <UserCard key={c.id} user={c} />
          ))}
        </div>
      )}

      <InviteUserModal open={inviteOpen} onClose={() => setInviteOpen(false)} systems={systems.data ?? []} />
    </div>
  );
}

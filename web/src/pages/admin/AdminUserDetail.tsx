/**
 * One user's admin detail page: identity header, then tabs for Overview
 * (stats + admin actions), Projects, Sessions, and Usage — all fed by the
 * same per-person analytics endpoints the Sessions page uses, plus the
 * admin-authoritative user record for the actions panel.
 */

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";

import { api } from "../../api/client";
import { qk } from "../../api/queryKeys";
import type { PersonDetail as Detail, UpdateUserPayload, User } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { Avatar } from "../../components/Avatar";
import { AdminUserActionsPanel } from "../../components/admin/AdminUserActionsPanel";
import { PersonProjectBars } from "../../components/person/PersonProjectBars";
import { PersonSessionTable } from "../../components/person/PersonSessionTable";
import { PersonStatGrid } from "../../components/person/PersonStatGrid";
import { PersonUsageChart } from "../../components/person/PersonUsageChart";
import {
  Badge,
  Card,
  CardHead,
  ErrorState,
  Eyebrow,
  LoadingState,
  Tabs,
  useToast,
} from "../../components/ui";

const RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
];

export function AdminUserDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();

  const [range, setRange] = useState("30d");
  const [tab, setTab] = useState("overview");

  useEffect(() => {
    document.title = "User details — Meterhouse";
  }, []);

  const users = useQuery({ queryKey: qk.users, queryFn: () => api.get<User[]>("/admin/users") });
  const admin = users.data?.find((u) => u.id === id);

  const detail = useQuery({
    queryKey: qk.person(id, range),
    queryFn: () => api.get<Detail>(`/people/${id}?range=${range}`),
    enabled: Number.isInteger(id),
  });

  const update = useMutation({
    mutationFn: (patch: UpdateUserPayload) => api.patch<User>(`/admin/users/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.users });
      qc.invalidateQueries({ queryKey: ["people"] });
      toast.push("Saved.");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/admin/users/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.users });
      qc.invalidateQueries({ queryKey: ["people"] });
      toast.push("User removed.");
      navigate("/admin/users");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  if (!Number.isInteger(id)) {
    return <ErrorState title="Invalid user" />;
  }

  if (detail.isLoading || users.isLoading) {
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
  const timeseries = detail.data!.timeseries;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link
          to="/admin/users"
          className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Users & roles
        </Link>
        <Eyebrow>Admin</Eyebrow>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <Avatar
            label={person.full_name || person.email}
            src={person.avatar_url}
            size="md"
            presence={person.status}
          />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {person.full_name || person.email}
            </h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted">
              {person.email}
              <Badge tone="neutral">{person.role}</Badge>
              {person.plan_label && (
                <Badge tone={person.plan_label.startsWith("Max") ? "accent" : "neutral"}>
                  {person.plan_label}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          items={[
            { id: "overview", label: "Overview" },
            { id: "projects", label: "Projects", badge: projects.length },
            { id: "sessions", label: "Sessions" },
            { id: "usage", label: "Usage" },
          ]}
          active={tab}
          onChange={setTab}
        />
        <div
          role="tablist"
          aria-label="Time range"
          className="inline-flex rounded-full border border-line bg-surface-2 p-1"
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

      {tab === "overview" && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHead title="Activity" />
            <PersonStatGrid person={person} projectCount={projects.length} range={range} />
          </Card>
          {admin ? (
            <AdminUserActionsPanel
              user={admin}
              isSelf={admin.id === me?.id}
              onUpdate={(patch) => update.mutate(patch)}
              updating={update.isPending}
              onDelete={() => remove.mutate()}
              deleting={remove.isPending}
            />
          ) : (
            <Card>
              <LoadingState label="Loading admin record…" />
            </Card>
          )}
        </div>
      )}

      {tab === "projects" && (
        <Card>
          <CardHead title="Projects" hint={`${projects.length} in this window`} />
          <PersonProjectBars projects={projects} mode="table" />
        </Card>
      )}

      {tab === "sessions" && (
        <Card>
          <PersonSessionTable personId={id} range={range} projects={projects} showHeader={false} />
        </Card>
      )}

      {tab === "usage" && (
        <Card>
          <CardHead title="Usage over time" />
          <PersonUsageChart timeseries={timeseries} />
        </Card>
      )}
    </div>
  );
}

/**
 * Initiative detail: a small local tab strip (Board / Milestones / Docs /
 * Activity) — `ui.tsx` has no Tabs primitive, and four styled buttons +
 * conditional render don't warrant adding one for a single page.
 */

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { Assignee, Doc, Initiative, Milestone, PmActivityEntry } from "../api/types";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { TaskBoard } from "../components/TaskBoard";
import {
  Badge,
  Button,
  Card,
  CardHead,
  EmptyState,
  ErrorState,
  Eyebrow,
  Field,
  Input,
  LoadingState,
  Select,
  Table,
  Td,
  Th,
  useToast,
} from "../components/ui";
import { fmtRelative } from "../lib/format";

type Tab = "board" | "milestones" | "docs" | "activity" | "sharing";
const TABS: { id: Tab; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "milestones", label: "Milestones" },
  { id: "docs", label: "Docs" },
  { id: "activity", label: "Activity" },
  { id: "sharing", label: "Client sharing" },
];

function MilestonesTab({ initiativeId }: { initiativeId: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [dueDate, setDueDate] = useState("");

  const q = useQuery({
    queryKey: qk.milestones(initiativeId),
    queryFn: () => api.get<Milestone[]>(`/initiatives/${initiativeId}/milestones`),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.milestones(initiativeId) });

  const create = useMutation({
    mutationFn: () =>
      api.post<Milestone>(`/initiatives/${initiativeId}/milestones`, {
        name: name.trim(),
        due_date: dueDate || null,
      }),
    onSuccess: () => {
      invalidate();
      setName("");
      setDueDate("");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const toggleStatus = useMutation({
    mutationFn: (m: Milestone) =>
      api.patch<Milestone>(`/milestones/${m.id}`, { status: m.status === "open" ? "done" : "open" }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/milestones/${id}`),
    onSuccess: invalidate,
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  return (
    <Card>
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
        <Field label="Milestone name">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Due date">
          {(p) => (
            <input
              {...p}
              type="date"
              className="h-11 w-full rounded-lg border border-line bg-surface-2 px-3 text-base text-ink"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          )}
        </Field>
        <Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
          Add milestone
        </Button>
      </div>

      {q.isLoading ? (
        <LoadingState />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (q.data?.length ?? 0) === 0 ? (
        <EmptyState title="No milestones yet" />
      ) : (
        <Table caption="Milestones for this initiative">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Due</Th>
              <Th>Status</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {q.data!.map((m) => (
              <tr key={m.id}>
                <Td className="font-medium">{m.name}</Td>
                <Td className="text-ink-2">{m.due_date ?? "—"}</Td>
                <Td>
                  <Badge tone={m.status === "done" ? "good" : "neutral"}>{m.status}</Badge>
                </Td>
                <Td align="right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => toggleStatus.mutate(m)}>
                      Mark {m.status === "open" ? "done" : "open"}
                    </Button>
                    <Button size="sm" variant="subtle" onClick={() => remove.mutate(m.id)}>
                      Delete
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function DocsTab({ initiativeId }: { initiativeId: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [body, setBody] = useState("");

  const q = useQuery({
    queryKey: qk.docs(initiativeId),
    queryFn: () => api.get<Doc[]>(`/initiatives/${initiativeId}/docs`),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.docs(initiativeId) });

  const create = useMutation({
    mutationFn: () => api.post<Doc>(`/initiatives/${initiativeId}/docs`, { title: newTitle.trim(), body: "" }),
    onSuccess: (doc) => {
      invalidate();
      setCreating(false);
      setNewTitle("");
      setSelected(doc.id);
      setBody("");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const save = useMutation({
    mutationFn: (docId: number) => api.patch<Doc>(`/docs/${docId}`, { body }),
    onSuccess: () => {
      invalidate();
      toast.push("Doc saved.");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const remove = useMutation({
    mutationFn: (docId: number) => api.del(`/docs/${docId}`),
    onSuccess: () => {
      invalidate();
      setSelected(null);
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const doc = q.data?.find((d) => d.id === selected);

  useEffect(() => {
    if (doc) setBody(doc.body);
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  if (doc) {
    return (
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <Button size="sm" variant="subtle" onClick={() => setSelected(null)}>
            ← All docs
          </Button>
          <Button size="sm" variant="ghost" onClick={() => remove.mutate(doc.id)}>
            Delete doc
          </Button>
        </div>
        <h3 className="mb-3 text-lg font-semibold">{doc.title}</h3>
        <MarkdownEditor value={body} onChange={setBody} rows={14} />
        {body !== doc.body && (
          <div className="mt-3 flex justify-end">
            <Button loading={save.isPending} onClick={() => save.mutate(doc.id)}>
              Save
            </Button>
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <div className="mb-4 flex justify-end">
        <Button size="sm" onClick={() => setCreating((v) => !v)}>
          New doc
        </Button>
      </div>
      {creating && (
        <div className="mb-4 flex gap-2">
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Doc title"
            autoFocus
          />
          <Button disabled={!newTitle.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Create
          </Button>
        </div>
      )}
      {(q.data?.length ?? 0) === 0 ? (
        <EmptyState title="No docs yet" hint="Notes, specs, or anything worth writing down." />
      ) : (
        <div className="flex flex-col gap-2">
          {q.data!.map((d) => (
            <button
              key={d.id}
              onClick={() => setSelected(d.id)}
              className="rounded-lg border border-line p-3 text-left text-sm hover:border-accent"
            >
              <div className="font-medium">{d.title}</div>
              <div className="mt-0.5 text-xs text-muted">Updated {fmtRelative(d.updated_at)}</div>
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

function ActivityTab({ initiativeId }: { initiativeId: number }) {
  const q = useQuery({
    queryKey: qk.activity(initiativeId),
    queryFn: () => api.get<PmActivityEntry[]>(`/initiatives/${initiativeId}/activity`),
  });

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  return (
    <Card>
      {(q.data?.length ?? 0) === 0 ? (
        <EmptyState title="No activity yet" />
      ) : (
        <div className="flex flex-col divide-y divide-line">
          {q.data!.map((a) => (
            <div key={a.id} className="flex items-baseline justify-between gap-3 py-2.5 text-sm">
              <span>
                <span className="font-semibold text-ink-2">{a.actor_email || "—"}</span>{" "}
                <span className="text-muted">{a.action}</span>
                {a.detail && <span className="text-ink-2"> — {a.detail}</span>}
              </span>
              <span className="shrink-0 text-xs text-muted">{fmtRelative(a.at)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

interface ClientRef {
  user_id: number;
  email: string;
  full_name: string;
}

/** Staff-only (the tab is only reachable outside the client portal anyway,
 * since a client-role account never lands on /workspace at all — see
 * App.tsx's role redirect). Shares/unshares this initiative with client-role
 * accounts, who then see it read-only (plus commenting) in the portal. */
function SharingTab({ initiativeId }: { initiativeId: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [pickedClient, setPickedClient] = useState("");

  const shared = useQuery({
    queryKey: qk.initiativeClients(initiativeId),
    queryFn: () => api.get<ClientRef[]>(`/initiatives/${initiativeId}/clients`),
  });
  const clients = useQuery({
    queryKey: qk.clientDirectory,
    queryFn: () => api.get<Assignee[]>("/pm/clients"),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.initiativeClients(initiativeId) });

  const share = useMutation({
    mutationFn: () => api.post(`/initiatives/${initiativeId}/clients`, { user_id: Number(pickedClient) }),
    onSuccess: () => {
      invalidate();
      setPickedClient("");
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const unshare = useMutation({
    mutationFn: (userId: number) => api.del(`/initiatives/${initiativeId}/clients/${userId}`),
    onSuccess: invalidate,
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const unsharedClients = clients.data?.filter((c) => !shared.data?.some((s) => s.user_id === c.id)) ?? [];

  return (
    <Card>
      <CardHead
        title="Shared with"
        hint="Client-portal accounts that can see this initiative read-only, plus comment on tasks."
      />
      {shared.isLoading ? (
        <LoadingState />
      ) : shared.isError ? (
        <ErrorState error={shared.error} onRetry={() => shared.refetch()} />
      ) : (
        <div className="mb-4 flex flex-col gap-2">
          {(shared.data?.length ?? 0) === 0 ? (
            <EmptyState title="Not shared with any client yet" />
          ) : (
            shared.data!.map((c) => (
              <div key={c.user_id} className="flex items-center justify-between rounded-lg border border-line p-2.5">
                <span className="text-sm">{c.full_name || c.email}</span>
                <Button size="sm" variant="subtle" onClick={() => unshare.mutate(c.user_id)}>
                  Remove
                </Button>
              </div>
            ))
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Select value={pickedClient} onChange={(e) => setPickedClient(e.target.value)}>
          <option value="">Select a client account…</option>
          {unsharedClients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.full_name || c.email}
            </option>
          ))}
        </Select>
        <Button disabled={!pickedClient} loading={share.isPending} onClick={() => share.mutate()}>
          Share
        </Button>
      </div>
      {clients.data?.length === 0 && (
        <p className="mt-2 text-xs text-muted">
          No client accounts exist yet — invite one from Users &amp; roles with the "Client" role.
        </p>
      )}
    </Card>
  );
}

export function InitiativeDetail() {
  const { id } = useParams<{ id: string }>();
  const initiativeId = Number(id);
  const [tab, setTab] = useState<Tab>("board");

  const q = useQuery({
    queryKey: qk.initiative(initiativeId),
    queryFn: () => api.get<Initiative>(`/initiatives/${initiativeId}`),
    enabled: Number.isInteger(initiativeId),
  });

  useEffect(() => {
    document.title = q.data ? `${q.data.name} — Meterhouse` : "Initiative — Meterhouse";
  }, [q.data]);

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Eyebrow>Work</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{q.data!.name}</h1>
        {q.data!.description && (
          <p className="mt-1.5 max-w-2xl text-base text-muted">{q.data!.description}</p>
        )}
      </div>

      <div className="flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`border-b-2 px-3 py-2 text-sm font-semibold transition ${
              tab === t.id ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink-2"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "board" && <TaskBoard initiativeId={initiativeId} />}
      {tab === "milestones" && <MilestonesTab initiativeId={initiativeId} />}
      {tab === "docs" && <DocsTab initiativeId={initiativeId} />}
      {tab === "activity" && <ActivityTab initiativeId={initiativeId} />}
      {tab === "sharing" && <SharingTab initiativeId={initiativeId} />}
    </div>
  );
}

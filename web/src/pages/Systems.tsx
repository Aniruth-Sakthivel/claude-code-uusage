/** Systems list — every connected PC with its status and totals. */

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { fleetKeys, qk } from "../api/queryKeys";
import type { CreateSystemPayload, SystemCreated, SystemRow, UpdateSystemPayload } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { Avatar } from "../components/Avatar";
import { ScanActivity } from "../components/ScanActivity";
import { SystemCommandsPanel } from "../components/SystemCommandsPanel";
import {
  Alert,
  Button,
  Card,
  CardHead,
  CodeBlock,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Eyebrow,
  Field,
  Input,
  LoadingState,
  Modal,
  Pagination,
  Select,
  StatusPill,
  Table,
  Td,
  Textarea,
  Th,
  useToast,
} from "../components/ui";
import { fmtRelative, fmtTokens } from "../lib/format";
import { useTableControls } from "../lib/useTableControls";

/** Mirrors the list in ConnectPanel.tsx — kept in sync there, not imported,
 * since ConnectPanel's copy is scoped to its own self-connect flow. */
const ENVIRONMENTS = ["", "development", "staging", "production", "personal"];

type SystemFormState = {
  display_name: string;
  owner: string;
  environment: string;
  location: string;
  notes: string;
};

const EMPTY_FORM: SystemFormState = {
  display_name: "",
  owner: "",
  environment: "",
  location: "",
  notes: "",
};

function SystemFormFields({
  form,
  onChange,
}: {
  form: SystemFormState;
  onChange: (next: SystemFormState) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Name" required>
        {(p) => (
          <Input
            {...p}
            value={form.display_name}
            onChange={(e) => onChange({ ...form, display_name: e.target.value })}
            placeholder="e.g. Alex's laptop"
            required
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Owner">
          {(p) => (
            <Input
              {...p}
              value={form.owner}
              onChange={(e) => onChange({ ...form, owner: e.target.value })}
              placeholder="Name or email"
            />
          )}
        </Field>
        <Field label="Environment">
          {(p) => (
            <Select
              {...p}
              value={form.environment}
              onChange={(e) => onChange({ ...form, environment: e.target.value })}
            >
              {ENVIRONMENTS.map((v) => (
                <option key={v} value={v}>
                  {v || "— none —"}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label="Location">
        {(p) => (
          <Input
            {...p}
            value={form.location}
            onChange={(e) => onChange({ ...form, location: e.target.value })}
            placeholder="e.g. Home office"
          />
        )}
      </Field>
      <Field label="Notes">
        {(p) => (
          <Textarea
            {...p}
            rows={3}
            value={form.notes}
            onChange={(e) => onChange({ ...form, notes: e.target.value })}
          />
        )}
      </Field>
    </div>
  );
}

/**
 * Worst first, so sorting descending puts what needs attention on top.
 * `dormant` sits with the healthy end: the agent runs continuously now, so it
 * only reports "stopped" after a deliberate `stop` command or an uninstall —
 * a rare, intentional state, not the common resting one.
 */
const HEALTH_ORDER: SystemRow["health"][] = [
  "dead",
  "stalled",
  "late",
  "never",
  "dormant",
  "healthy",
];

/**
 * What each status means, and — more usefully — what to do about it.
 *
 * The agent runs continuously now (no Claude Code session gating), so
 * `healthy` is the expected steady state for essentially every connected PC.
 * Spelling out the exceptions on the page beats leaving them to a tooltip.
 */
function StatusLegend() {
  const items: { health: SystemRow["health"]; means: string }[] = [
    { health: "healthy", means: "Running and reporting normally." },
    { health: "dormant", means: "Stopped deliberately (a Stop command, or uninstalled)." },
    { health: "late", means: "Missed a check-in — usually asleep or offline." },
    { health: "stalled", means: "Went quiet without stopping cleanly. Try Restart agent." },
    { health: "dead", means: "No contact for over a day. Re-run the connect command." },
    { health: "never", means: "Enrolled but has never reported. Finish setup on that PC." },
  ];

  return (
    <details className="rounded-xl border border-line bg-surface-2 px-4 py-3">
      <summary className="cursor-pointer text-sm font-semibold">
        What do these statuses mean?
      </summary>
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {items.map((i) => (
          <div key={i.health} className="flex items-baseline gap-2">
            <dt className="shrink-0">
              <StatusPill health={i.health} status="" />
            </dt>
            <dd className="text-sm text-muted">{i.means}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function Systems() {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can("manage_systems");

  const [pendingDelete, setPendingDelete] = useState<SystemRow | null>(null);
  const [managing, setManaging] = useState<SystemRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState<SystemFormState>(EMPTY_FORM);
  const [editing, setEditing] = useState<SystemRow | null>(null);
  const [editForm, setEditForm] = useState<SystemFormState>(EMPTY_FORM);
  const [revealedKey, setRevealedKey] = useState<{ key: string; systemName: string } | null>(null);

  const q = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
    // A scan takes seconds. At the old 60s poll the "Scanning…" state was
    // usually over before the table ever saw it, which is precisely the moment
    // an admin is watching for.
    refetchInterval: 10_000,
  });

  const remove = useMutation({
    mutationFn: (systemId: string) => api.del(`/admin/systems/${systemId}`),
    onSuccess: () => {
      fleetKeys.forEach((key) => qc.invalidateQueries({ queryKey: key }));
      toast.push("System removed.");
      setPendingDelete(null);
    },
    onError: (e: Error) => {
      toast.push(e.message, "error");
      setPendingDelete(null);
    },
  });

  const create = useMutation({
    mutationFn: (payload: CreateSystemPayload) => api.post<SystemCreated>("/admin/systems", payload),
    onSuccess: (data) => {
      fleetKeys.forEach((key) => qc.invalidateQueries({ queryKey: key }));
      setRevealedKey({ key: data.api_key, systemName: data.system.display_name });
      setCreating(false);
      setCreateForm(EMPTY_FORM);
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateSystemPayload }) =>
      api.patch<SystemRow>(`/admin/systems/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.systems });
      toast.push("System updated.");
      setEditing(null);
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  function submitCreate(e: FormEvent) {
    e.preventDefault();
    create.mutate({
      display_name: createForm.display_name.trim(),
      owner: createForm.owner.trim(),
      environment: createForm.environment,
      location: createForm.location.trim(),
      notes: createForm.notes.trim(),
    });
  }

  function openEdit(s: SystemRow) {
    setEditing(s);
    setEditForm({
      display_name: s.display_name,
      owner: s.owner,
      environment: s.environment,
      location: s.location,
      notes: s.notes,
    });
  }

  function submitEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    update.mutate({
      id: editing.system_id,
      patch: {
        display_name: editForm.display_name.trim(),
        owner: editForm.owner.trim(),
        environment: editForm.environment,
        location: editForm.location.trim(),
        notes: editForm.notes.trim(),
      },
    });
  }

  useEffect(() => {
    document.title = "Systems — Meterhouse";
  }, []);

  const table = useTableControls(q.data, {
    searchText: (s) => `${s.display_name} ${s.hostname ?? ""} ${s.owner ?? ""}`,
    sorters: {
      name: (a, b) => a.display_name.localeCompare(b.display_name),
      // Sorted by the graded health the column actually renders, not by the
      // binary online flag. Those disagree now: a machine that stopped
      // cleanly is "offline" by check-in age but shows as Idle, so sorting on
      // `status` buried healthy machines among genuinely broken ones.
      status: (a, b) => HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health),
      tracked: (a, b) => a.total_tokens - b.total_tokens,
      projects: (a, b) => a.projects - b.projects,
      // Never-synced machines sort as epoch 0, so they land at the bottom of
      // the default (most-recent-first) view rather than the top.
      sync: (a, b) =>
        new Date(a.last_sync_at ?? 0).getTime() - new Date(b.last_sync_at ?? 0).getTime(),
    },
    descFirst: ["tracked", "projects", "sync", "status"],
    initialSortKey: "sync",
    initialSortDir: "desc",
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Eyebrow>Fleet</Eyebrow>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Systems</h1>
          <p className="mt-1.5 max-w-3xl text-base text-muted">
            Every PC reporting usage, with its live status. The agent runs continuously,
            independent of Claude Code sessions, so{" "}
            <span className="font-medium text-ink-2">Working</span> is the normal state
            for a connected PC.
          </p>
        </div>
        {canManage && (
          <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
            Add system manually
          </Button>
        )}
      </div>

      {revealedKey && (
        <Card>
          <CardHead
            title={`${revealedKey.systemName} — system created`}
            right={
              <Button variant="subtle" size="sm" onClick={() => setRevealedKey(null)}>
                Done
              </Button>
            }
          />
          <Alert tone="warn" title="Copy this now">
            This is the only time the full API key is shown.
          </Alert>
          <div className="mt-3">
            <CodeBlock code={revealedKey.key} />
          </div>
        </Card>
      )}

      <StatusLegend />

      <Card>
        {q.isLoading ? (
          <LoadingState />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data!.length === 0 ? (
          <EmptyState
            title="No systems visible"
            hint="Connect a PC, or ask an administrator to assign you one."
            action={
              <Link to="/connect">
                <Button size="sm">Connect a PC</Button>
              </Link>
            }
          />
        ) : (
          <>
            <div className="mb-3">
              <Input
                type="search"
                placeholder="Search by name, hostname, or owner…"
                value={table.query}
                onChange={(e) => table.setQuery(e.target.value)}
                aria-label="Search systems"
              />
            </div>
            {table.total === 0 ? (
              <EmptyState title="No systems match your search" />
            ) : (
              <Table caption="Systems with status, owner and tracked usage">
                <thead>
                  <tr>
                    <Th
                      sortDir={table.sortKey === "name" ? table.sortDir : null}
                      onSort={() => table.toggleSort("name")}
                    >
                      PC
                    </Th>
                    <Th
                      sortDir={table.sortKey === "status" ? table.sortDir : null}
                      onSort={() => table.toggleSort("status")}
                    >
                      Status
                    </Th>
                    <Th>Scan activity</Th>
                    <Th>Owner</Th>
                    <Th>Environment</Th>
                    <Th
                      sortDir={table.sortKey === "sync" ? table.sortDir : null}
                      onSort={() => table.toggleSort("sync")}
                    >
                      Last sync
                    </Th>
                    <Th
                      align="right"
                      sortDir={table.sortKey === "tracked" ? table.sortDir : null}
                      onSort={() => table.toggleSort("tracked")}
                    >
                      Tracked
                    </Th>
                    <Th
                      align="right"
                      sortDir={table.sortKey === "projects" ? table.sortDir : null}
                      onSort={() => table.toggleSort("projects")}
                    >
                      Projects
                    </Th>
                    {canManage && <Th align="right">Actions</Th>}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((s) => (
                <tr key={s.system_id}>
                  <Td>
                    <div className="font-semibold">{s.display_name}</div>
                    <div className="text-xs text-muted">{s.hostname || "—"}</div>
                  </Td>
                  <Td>
                    <StatusPill status={s.status} neverSynced={s.never_synced} health={s.health} reason={s.reason} />
                    {s.active_sessions > 0 && (
                      // The reason the agent is running at all. Without it the
                      // row says "Working" with nothing to say what it is
                      // working on.
                      <div className="text-xs text-muted">
                        {s.active_sessions} session{s.active_sessions === 1 ? "" : "s"} open
                      </div>
                    )}
                  </Td>
                  <Td>
                    <ScanActivity scan={s} neverReported={s.never_synced} />
                  </Td>
                  <Td>
                    {s.owner ? (
                      <div className="flex items-center gap-2.5">
                        <Avatar label={s.owner} />
                        <span className="truncate text-sm text-ink-2">{s.owner}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2.5">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-dashed border-line text-2xs text-muted">
                          —
                        </span>
                        <span className="text-sm text-muted">No owner</span>
                      </div>
                    )}
                  </Td>
                  <Td className="text-ink-2">{s.environment || "—"}</Td>
                  <Td className="tnum text-ink-2">
                    {s.never_synced ? "never" : fmtRelative(s.last_sync_at)}
                  </Td>
                  <Td align="right" className="tnum font-semibold">
                    {fmtTokens(s.total_tokens)}
                  </Td>
                  <Td align="right" className="tnum text-ink-2">
                    {s.projects}
                  </Td>
                  {canManage && (
                    <Td align="right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEdit(s)}
                          aria-label={`Edit ${s.display_name}`}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setManaging(s)}
                          aria-label={`Agent controls for ${s.display_name}`}
                        >
                          Agent controls
                        </Button>
                        <Button
                          size="sm"
                          variant="subtle"
                          onClick={() => setPendingDelete(s)}
                          aria-label={`Remove ${s.display_name}`}
                        >
                          Remove
                        </Button>
                      </div>
                    </Td>
                  )}
                </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <Pagination
              page={table.page}
              pageCount={table.pageCount}
              total={table.total}
              pageSize={table.pageSize}
              onPage={table.setPage}
            />
          </>
        )}
      </Card>

      {managing && <SystemCommandsPanel system={managing} onClose={() => setManaging(null)} />}

      <Modal
        open={creating}
        title="Add a system"
        hint="This registers a system record without an agent connected. Use Connect a PC if you want it to start reporting usage automatically."
        onClose={() => setCreating(false)}
      >
        <form onSubmit={submitCreate} className="flex flex-col gap-4">
          <SystemFormFields form={createForm} onChange={setCreateForm} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={create.isPending}
              disabled={!createForm.display_name.trim()}
            >
              Add system
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={editing !== null}
        title={`Edit ${editing?.display_name ?? ""}`}
        onClose={() => setEditing(null)}
      >
        <form onSubmit={submitEdit} className="flex flex-col gap-4">
          <SystemFormFields form={editForm} onChange={setEditForm} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={update.isPending}
              disabled={!editForm.display_name.trim()}
            >
              Save changes
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Remove ${pendingDelete?.display_name}?`}
        body="The PC, its API keys, and all usage data collected from it are deleted permanently. This cannot be undone — reconnecting later creates a new system with fresh history."
        confirmLabel="Remove system"
        destructive
        busy={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.system_id)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

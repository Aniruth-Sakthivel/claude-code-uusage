/**
 * Users & roles.
 *
 * Replaces the old unlabelled four-field form with a proper invite flow: enter
 * an email and role, and the person receives a Supabase invite to set their own
 * password. That removes the previous requirement to read a password aloud to
 * someone. A password can still be set directly for scripted setups.
 *
 * Destructive actions now confirm first, and failures surface as toasts —
 * previously they failed silently.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type {
  CreateUserPayload,
  Role,
  SystemRow,
  UpdateUserPayload,
  User,
} from "../api/types";
import { useAuth } from "../auth/AuthContext";
import {
  Badge,
  Button,
  Card,
  CardHead,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Eyebrow,
  Field,
  FormCard,
  Input,
  LoadingState,
  Select,
  Table,
  Td,
  Th,
  useToast,
} from "../components/ui";

const ROLES: { value: Role; label: string; blurb: string }[] = [
  { value: "admin", label: "Administrator", blurb: "Full access, including users and keys." },
  { value: "manager", label: "Manager", blurb: "Sees every PC and all analytics." },
  { value: "developer", label: "Developer", blurb: "Sees only the PCs you assign." },
  { value: "viewer", label: "Viewer", blurb: "Read-only across every PC." },
];

export function AdminUsers() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user: me } = useAuth();

  const [form, setForm] = useState({
    email: "",
    full_name: "",
    role: "developer" as Role,
    system_ids: [] as string[],
    password: "",
  });
  const [usePassword, setUsePassword] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<User | null>(null);

  useEffect(() => {
    document.title = "Users & roles — ClaudeFleet";
  }, []);

  const users = useQuery({ queryKey: qk.users, queryFn: () => api.get<User[]>("/admin/users") });
  const systems = useQuery({
    queryKey: qk.systems,
    queryFn: () => api.get<SystemRow[]>("/systems"),
  });

  const create = useMutation({
    mutationFn: (payload: CreateUserPayload) => api.post<User>("/admin/users", payload),
    onSuccess: (_u, payload) => {
      qc.invalidateQueries({ queryKey: qk.users });
      toast.push(
        payload.password
          ? `Account created for ${payload.email}.`
          : `Invite sent to ${payload.email}.`,
      );
      setForm({ email: "", full_name: "", role: "developer", system_ids: [], password: "" });
      setUsePassword(false);
    },
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: UpdateUserPayload }) =>
      api.patch<User>(`/admin/users/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users }),
    onError: (e: Error) => toast.push(e.message, "error"),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/admin/users/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.users });
      toast.push("User removed.");
      setPendingDelete(null);
    },
    onError: (e: Error) => {
      toast.push(e.message, "error");
      setPendingDelete(null);
    },
  });

  function toggleSystem(id: string) {
    setForm((f) => ({
      ...f,
      system_ids: f.system_ids.includes(id)
        ? f.system_ids.filter((x) => x !== id)
        : [...f.system_ids, id],
    }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const payload: CreateUserPayload = {
      email: form.email.trim(),
      full_name: form.full_name.trim(),
      role: form.role,
      system_ids: form.role === "developer" ? form.system_ids : [],
    };
    if (usePassword && form.password) payload.password = form.password;
    create.mutate(payload);
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Eyebrow>Admin</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Users &amp; roles</h1>
        <p className="mt-1.5 text-base text-muted">
          Invite teammates and control which machines each of them can see.
        </p>
      </div>

      <FormCard className="flex flex-col gap-4" onSubmit={submit}>
        <CardHead title="Invite someone" hint="They set their own password by email." />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" required>
            {(p) => (
              <Input
                {...p}
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="teammate@company.com"
                required
              />
            )}
          </Field>

          <Field label="Full name">
            {(p) => (
              <Input
                {...p}
                value={form.full_name}
                onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
                placeholder="Alex Kim"
              />
            )}
          </Field>
        </div>

        <Field
          label="Role"
          hint={ROLES.find((r) => r.value === form.role)?.blurb}
          required
        >
          {(p) => (
            <Select
              {...p}
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role }))}
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {form.role === "developer" && (
          <div>
            <div className="mb-2 text-xs font-semibold text-ink-2">
              Which PCs can they see?
            </div>
            {systems.data?.length ? (
              <div className="flex flex-wrap gap-2">
                {systems.data.map((s) => {
                  const on = form.system_ids.includes(s.system_id);
                  return (
                    <button
                      key={s.system_id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleSystem(s.system_id)}
                      className={`rounded-lg border px-2.5 py-1.5 text-sm font-medium transition ${
                        on
                          ? "border-line bg-accent-weak text-accent"
                          : "border-line bg-surface-2 text-ink-2"
                      }`}
                    >
                      {s.display_name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted">
                No PCs yet — you can assign them after connecting one.
              </p>
            )}
            {form.system_ids.length === 0 && (
              <p className="mt-2 text-xs text-muted">
                With none selected they will see an empty dashboard.
              </p>
            )}
          </div>
        )}

        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            checked={usePassword}
            onChange={(e) => setUsePassword(e.target.checked)}
          />
          Set a password instead of sending an invite
        </label>

        {usePassword && (
          <Field label="Password" hint="At least 8 characters." required>
            {(p) => (
              <Input
                {...p}
                type="password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                minLength={8}
                required
              />
            )}
          </Field>
        )}

        <div>
          <Button type="submit" loading={create.isPending} disabled={!form.email.trim()}>
            {usePassword ? "Create account" : "Send invite"}
          </Button>
        </div>
      </FormCard>

      <Card>
        <CardHead title="People" hint={users.data ? `${users.data.length} total` : undefined} />
        {users.isLoading ? (
          <LoadingState />
        ) : users.isError ? (
          <ErrorState error={users.error} onRetry={() => users.refetch()} />
        ) : users.data!.length === 0 ? (
          <EmptyState title="No users yet" />
        ) : (
          <Table caption="User accounts, roles and system assignments">
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Role</Th>
                <Th>Sees</Th>
                <Th>Status</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {users.data!.map((u) => {
                const isSelf = u.id === me?.id;
                return (
                  <tr key={u.id}>
                    <Td>
                      <div className="font-medium">{u.full_name || u.email}</div>
                      <div className="text-xs text-muted">{u.email}</div>
                    </Td>
                    <Td>
                      <Select
                        aria-label={`Role for ${u.email}`}
                        value={u.role}
                        disabled={isSelf}
                        onChange={(e) =>
                          update.mutate({
                            id: u.id,
                            patch: { role: e.target.value as Role },
                          })
                        }
                        className="!w-auto !py-1.5 !text-sm"
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    <Td className="text-ink-2">
                      {u.role === "developer"
                        ? u.system_ids.length === 0
                          ? "no PCs assigned"
                          : `${u.system_ids.length} PC${u.system_ids.length === 1 ? "" : "s"}`
                        : "all PCs"}
                    </Td>
                    <Td>
                      {u.is_active ? (
                        <Badge tone="good">Active</Badge>
                      ) : (
                        <Badge tone="critical">Disabled</Badge>
                      )}
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isSelf}
                          onClick={() =>
                            update.mutate({ id: u.id, patch: { is_active: !u.is_active } })
                          }
                        >
                          {u.is_active ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          size="sm"
                          variant="subtle"
                          disabled={isSelf}
                          onClick={() => setPendingDelete(u)}
                        >
                          Delete
                        </Button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete ${pendingDelete?.email}?`}
        body="Their account and sign-in are removed permanently. Usage data already collected is kept."
        confirmLabel="Delete user"
        destructive
        busy={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

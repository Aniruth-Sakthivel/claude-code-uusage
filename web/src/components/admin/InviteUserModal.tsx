/**
 * Invite-a-user form, in a modal — migrated out of the old always-visible
 * form on the admin users table page.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../../api/client";
import { qk } from "../../api/queryKeys";
import type { CreatedUser, CreateUserPayload, Role, SystemRow } from "../../api/types";
import { ROLES } from "../../lib/roles";
import { Button, Field, Input, Modal, Select, useToast } from "../ui";

export function InviteUserModal({
  open,
  onClose,
  systems,
}: {
  open: boolean;
  onClose: () => void;
  systems: SystemRow[];
}) {
  const qc = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState({
    email: "",
    full_name: "",
    role: "developer" as Role,
    system_ids: [] as string[],
    password: "",
  });
  const [usePassword, setUsePassword] = useState(false);

  const create = useMutation({
    mutationFn: (payload: CreateUserPayload) => api.post<CreatedUser>("/admin/users", payload),
    onSuccess: (created, payload) => {
      qc.invalidateQueries({ queryKey: qk.users });
      qc.invalidateQueries({ queryKey: ["people"] });
      toast.push(
        payload.password
          ? `Account created for ${payload.email}.`
          : `Invite sent to ${payload.email}. They can sign in with ${payload.email} / ` +
              `${created.default_password ?? "the default password"}.`,
      );
      setForm({ email: "", full_name: "", role: "developer", system_ids: [], password: "" });
      setUsePassword(false);
      onClose();
    },
    onError: (e: Error) => toast.push(e.message, "error"),
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
    <Modal
      open={open}
      onClose={onClose}
      title="Invite someone"
      hint="The email carries their login details and a link to set their own password."
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
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

        <Field label="Role" hint={ROLES.find((r) => r.value === form.role)?.blurb} required>
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
            <div className="mb-2 text-xs font-semibold text-ink-2">Which PCs can they see?</div>
            {systems.length ? (
              <div className="flex flex-wrap gap-2">
                {systems.map((s) => {
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
              <p className="text-sm text-muted">No PCs yet — you can assign them after connecting one.</p>
            )}
            {form.system_ids.length === 0 && (
              <p className="mt-2 text-xs text-muted">With none selected they will see an empty dashboard.</p>
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

        <div className="flex justify-end">
          <Button type="submit" loading={create.isPending} disabled={!form.email.trim()}>
            {usePassword ? "Create account" : "Send invite"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

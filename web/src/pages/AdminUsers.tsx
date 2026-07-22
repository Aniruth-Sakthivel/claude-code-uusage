import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Role, SystemRow, User } from "../api/types";
import { Button, Card, CardHead, EmptyState, Spinner } from "../components/ui";

const ROLES: Role[] = ["admin", "manager", "developer", "viewer"];

export function AdminUsers() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api.get<User[]>("/api/v1/admin/users") });
  const systems = useQuery({ queryKey: ["systems"], queryFn: () => api.get<SystemRow[]>("/api/v1/systems") });

  const [form, setForm] = useState({ email: "", full_name: "", password: "", role: "viewer" as Role, system_ids: [] as string[] });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<User>("/api/v1/admin/users", form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setForm({ email: "", full_name: "", password: "", role: "viewer", system_ids: [] });
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: (u: User) => api.patch<User>(`/api/v1/admin/users/${u.id}`, { is_active: !u.is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/api/v1/admin/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });

  const input = "w-full rounded-lg border px-3 py-2 text-[13px] outline-none";
  const inputStyle = { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--ink)" };

  return (
    <div>
      <h2 className="mb-1 text-[21px] font-semibold tracking-tight">Users & roles</h2>
      <p className="mb-5 text-[13.5px]" style={{ color: "var(--ink-2)" }}>
        Developers see only their assigned systems — enforced server-side.
      </p>

      <Card className="mb-4">
        <CardHead title="Add user" />
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))" }}>
          <input className={input} style={inputStyle} placeholder="Email" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className={input} style={inputStyle} placeholder="Full name" value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          <input className={input} style={inputStyle} type="password" placeholder="Password (min 8)" value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className={input} style={inputStyle} value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        {form.role === "developer" && (
          <div className="mt-3">
            <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>Assign systems</div>
            <div className="flex flex-wrap gap-2">
              {(systems.data ?? []).map((s) => {
                const on = form.system_ids.includes(s.system_id);
                return (
                  <button key={s.system_id} type="button"
                    onClick={() => setForm({ ...form, system_ids: on ? form.system_ids.filter((x) => x !== s.system_id) : [...form.system_ids, s.system_id] })}
                    className="rounded-full border px-3 py-1 text-[12px] font-medium"
                    style={on ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" }
                      : { background: "var(--surface-2)", color: "var(--ink-2)", borderColor: "var(--border)" }}>
                    {s.display_name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {error && <div className="mt-3 text-[12.5px]" style={{ color: "var(--critical)" }}>{error}</div>}
        <div className="mt-4"><Button onClick={() => create.mutate()} disabled={create.isPending}>Create user</Button></div>
      </Card>

      <Card>
        <CardHead title="Users" hint={`${users.data?.length ?? 0} total`} />
        {users.isLoading ? <Spinner /> : (users.data?.length ?? 0) === 0 ? <EmptyState title="No users" /> : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-[0.06em]" style={{ color: "var(--muted)" }}>
                  {["Email", "Name", "Role", "Systems", "Status", ""].map((h) => <th key={h} className="px-3 pb-2.5 font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {(users.data ?? []).map((u) => (
                  <tr key={u.id} className="text-[13px]" style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="px-3 py-3 font-medium">{u.email}</td>
                    <td className="px-3 py-3" style={{ color: "var(--ink-2)" }}>{u.full_name || "—"}</td>
                    <td className="px-3 py-3 capitalize">{u.role}</td>
                    <td className="px-3 py-3" style={{ color: "var(--ink-2)" }}>{u.role === "developer" ? `${u.system_ids.length} assigned` : "all"}</td>
                    <td className="px-3 py-3" style={{ color: u.is_active ? "var(--good)" : "var(--muted)" }}>{u.is_active ? "Active" : "Disabled"}</td>
                    <td className="px-3 py-3">
                      <div className="flex gap-2">
                        <button className="text-[12px] font-semibold" style={{ color: "var(--accent)" }} onClick={() => toggleActive.mutate(u)}>
                          {u.is_active ? "Disable" : "Enable"}
                        </button>
                        <button className="text-[12px] font-semibold" style={{ color: "var(--critical)" }} onClick={() => remove.mutate(u.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ApiKeyRow, SystemRow } from "../api/types";
import { Button, Card, CardHead, EmptyState, Spinner } from "../components/ui";
import { fmtRelative } from "../lib/format";

// A freshly-minted key is shown exactly once — the server only stores its hash.
function KeyReveal({ value, onClose }: { value: string; onClose: () => void }) {
  return (
    <div className="mb-4 rounded-xl border p-4" style={{ background: "var(--accent-weak)", borderColor: "var(--accent)" }}>
      <div className="mb-1 text-[12.5px] font-semibold" style={{ color: "var(--accent)" }}>
        Copy this API key now — it won't be shown again.
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-lg px-3 py-2 text-[12.5px]"
          style={{ background: "var(--surface)", color: "var(--ink)" }}>{value}</code>
        <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(value)}>Copy</Button>
        <Button variant="ghost" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

export function AdminKeys() {
  const qc = useQueryClient();
  const systems = useQuery({ queryKey: ["systems"], queryFn: () => api.get<SystemRow[]>("/api/v1/systems") });
  const [selected, setSelected] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);

  const sysId = selected ?? systems.data?.[0]?.system_id ?? null;
  const keys = useQuery({
    queryKey: ["keys", sysId],
    queryFn: () => api.get<ApiKeyRow[]>(`/api/v1/admin/systems/${sysId}/keys`),
    enabled: !!sysId,
  });

  const addSystem = useMutation({
    mutationFn: () => api.post<{ api_key: string; system: SystemRow }>("/api/v1/admin/systems", { display_name: newName }),
    onSuccess: (r) => { setRevealed(r.api_key); setNewName(""); qc.invalidateQueries({ queryKey: ["systems"] }); },
  });
  const addKey = useMutation({
    mutationFn: () => api.post<{ api_key: string }>(`/api/v1/admin/systems/${sysId}/keys`, { name: "key" }),
    onSuccess: (r) => { setRevealed(r.api_key); qc.invalidateQueries({ queryKey: ["keys", sysId] }); },
  });
  const rotate = useMutation({
    mutationFn: (id: number) => api.post<{ api_key: string }>(`/api/v1/admin/keys/${id}/rotate`),
    onSuccess: (r) => { setRevealed(r.api_key); qc.invalidateQueries({ queryKey: ["keys", sysId] }); },
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.del(`/api/v1/admin/keys/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["keys", sysId] }),
  });

  const input = "rounded-lg border px-3 py-2 text-[13px] outline-none";
  const inputStyle = { background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--ink)" };

  return (
    <div>
      <h2 className="mb-1 text-[21px] font-semibold tracking-tight">Agent API keys</h2>
      <p className="mb-5 text-[13.5px]" style={{ color: "var(--ink-2)" }}>
        Each PC authenticates with its own key. Keys are hashed at rest and revealed once.
      </p>

      {revealed && <KeyReveal value={revealed} onClose={() => setRevealed(null)} />}

      <Card className="mb-4">
        <CardHead title="Enroll a new system" />
        <div className="flex flex-wrap items-center gap-2">
          <input className={input} style={inputStyle} placeholder="Display name, e.g. PC-04" value={newName}
            onChange={(e) => setNewName(e.target.value)} />
          <Button onClick={() => addSystem.mutate()} disabled={!newName || addSystem.isPending}>Create system + key</Button>
        </div>
      </Card>

      <Card>
        <CardHead title="Keys" right={
          <select className={input} style={inputStyle} value={sysId ?? ""} onChange={(e) => setSelected(e.target.value)}>
            {(systems.data ?? []).map((s) => <option key={s.system_id} value={s.system_id}>{s.display_name}</option>)}
          </select>
        } />
        {!sysId ? <EmptyState title="No systems yet" hint="Enroll a system above to mint its first key." />
          : keys.isLoading ? <Spinner /> : (
          <>
            <div className="mb-3"><Button variant="ghost" onClick={() => addKey.mutate()} disabled={addKey.isPending}>+ New key for this system</Button></div>
            {(keys.data?.length ?? 0) === 0 ? <EmptyState title="No keys" /> : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="text-left text-[10.5px] uppercase tracking-[0.06em]" style={{ color: "var(--muted)" }}>
                      {["Prefix", "Name", "Created", "Last used", "Status", ""].map((h) => <th key={h} className="px-3 pb-2.5 font-semibold">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {(keys.data ?? []).map((k) => (
                      <tr key={k.id} className="text-[13px]" style={{ borderTop: "1px solid var(--border)" }}>
                        <td className="tnum px-3 py-3 font-medium">{k.prefix}…</td>
                        <td className="px-3 py-3" style={{ color: "var(--ink-2)" }}>{k.name}</td>
                        <td className="px-3 py-3" style={{ color: "var(--ink-2)" }}>{fmtRelative(k.created_at)}</td>
                        <td className="px-3 py-3" style={{ color: "var(--ink-2)" }}>{fmtRelative(k.last_used_at)}</td>
                        <td className="px-3 py-3" style={{ color: k.active ? "var(--good)" : "var(--muted)" }}>{k.active ? "Active" : "Revoked"}</td>
                        <td className="px-3 py-3">
                          {k.active && (
                            <div className="flex gap-2">
                              <button className="text-[12px] font-semibold" style={{ color: "var(--accent)" }} onClick={() => rotate.mutate(k.id)}>Rotate</button>
                              <button className="text-[12px] font-semibold" style={{ color: "var(--critical)" }} onClick={() => revoke.mutate(k.id)}>Revoke</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

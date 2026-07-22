import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { AuditRow } from "../api/types";
import { Card, CardHead, EmptyState, Spinner } from "../components/ui";
import { fmtRelative } from "../lib/format";

export function AdminAudit() {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api.get<AuditRow[]>("/api/v1/admin/audit") });
  return (
    <div>
      <h2 className="mb-1 text-[21px] font-semibold tracking-tight">Audit log</h2>
      <p className="mb-5 text-[13.5px]" style={{ color: "var(--ink-2)" }}>
        Security-relevant actions. Never records secrets, prompts, responses, or source.
      </p>
      <Card>
        <CardHead title="Recent activity" hint={`${q.data?.length ?? 0} entries`} />
        {q.isLoading ? <Spinner /> : (q.data?.length ?? 0) === 0 ? <EmptyState title="No audit entries" /> : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-[0.06em]" style={{ color: "var(--muted)" }}>
                  {["When", "Actor", "Action", "Target", "Detail"].map((h) => <th key={h} className="px-3 pb-2.5 font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {(q.data ?? []).map((a) => (
                  <tr key={a.id} className="text-[13px]" style={{ borderTop: "1px solid var(--border)" }}>
                    <td className="px-3 py-3" style={{ color: "var(--ink-2)" }}>{fmtRelative(a.at)}</td>
                    <td className="px-3 py-3">{a.actor_email}</td>
                    <td className="px-3 py-3"><code className="text-[12px]">{a.action}</code></td>
                    <td className="px-3 py-3" style={{ color: "var(--ink-2)" }}>{a.target || "—"}</td>
                    <td className="px-3 py-3" style={{ color: "var(--ink-2)" }}>{a.detail || "—"}</td>
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

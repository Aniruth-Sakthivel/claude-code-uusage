import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { SystemRow } from "../api/types";
import { Card, CardHead, EmptyState, Spinner, StatusPill } from "../components/ui";
import { fmtTokens, fmtRelative, systemColor } from "../lib/format";

export function Systems() {
  const q = useQuery({ queryKey: ["systems"], queryFn: () => api.get<SystemRow[]>("/api/v1/systems") });

  return (
    <div>
      <h2 className="mb-1 text-[21px] font-semibold tracking-tight">Systems</h2>
      <p className="mb-5 text-[13.5px]" style={{ color: "var(--ink-2)" }}>Compare the machines in your fleet.</p>
      <Card>
        <CardHead title="Fleet" hint={`${q.data?.length ?? 0} systems`} />
        {q.isLoading ? <Spinner /> : (q.data?.length ?? 0) === 0
          ? <EmptyState title="No systems visible" hint="An admin can enroll systems and assign them to you." />
          : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-[10.5px] uppercase tracking-[0.06em]" style={{ color: "var(--muted)" }}>
                    {["System", "Owner", "Location", "Status", "Last seen", "Tracked", "Sessions", "Projects"].map((h, i) => (
                      <th key={h} className={`px-3 pb-2.5 font-semibold ${i >= 5 ? "text-right" : ""}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(q.data ?? []).map((sys, i) => (
                    <tr key={sys.system_id} className="text-[13px]" style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2.5">
                          <span className="h-2.5 w-2.5 flex-none rounded-[3px]" style={{ background: systemColor(i) }} />
                          <span>
                            <span className="font-semibold">{sys.display_name}</span>
                            {sys.environment && (
                              <span className="ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase"
                                style={{ background: "var(--surface-2)", color: "var(--ink-2)" }}>{sys.environment}</span>
                            )}
                            <br /><span className="text-[11px]" style={{ color: "var(--muted)" }}>{sys.hostname || "—"}</span>
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-3" style={{ color: "var(--ink-2)" }}>{sys.owner || "—"}</td>
                      <td className="px-3 py-3" style={{ color: "var(--ink-2)" }}>{sys.location || "—"}</td>
                      <td className="px-3 py-3"><StatusPill status={sys.status} /></td>
                      <td className="tnum px-3 py-3" style={{ color: "var(--ink-2)" }}>{fmtRelative(sys.last_seen_at)}</td>
                      <td className="tnum px-3 py-3 text-right font-semibold">{fmtTokens(sys.total_tokens)}</td>
                      <td className="tnum px-3 py-3 text-right" style={{ color: "var(--ink-2)" }}>{sys.sessions}</td>
                      <td className="tnum px-3 py-3 text-right" style={{ color: "var(--ink-2)" }}>{sys.projects}</td>
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

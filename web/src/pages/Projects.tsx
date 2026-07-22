import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Project, SystemRow } from "../api/types";
import { Card, CardHead, EmptyState, Spinner } from "../components/ui";
import { fmtTokens } from "../lib/format";

export function Projects() {
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.get<Project[]>("/api/v1/projects") });
  const systems = useQuery({ queryKey: ["systems"], queryFn: () => api.get<SystemRow[]>("/api/v1/systems") });
  const nameOf = new Map((systems.data ?? []).map((s) => [s.system_id, s.display_name]));

  return (
    <div>
      <h2 className="mb-1 text-[21px] font-semibold tracking-tight">Projects</h2>
      <p className="mb-5 text-[13.5px]" style={{ color: "var(--ink-2)" }}>Token activity per project, per system (metadata only).</p>
      <Card>
        <CardHead title="Projects" hint={`${projects.data?.length ?? 0} projects`} />
        {projects.isLoading ? <Spinner /> : (projects.data?.length ?? 0) === 0
          ? <EmptyState title="No project activity yet" />
          : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-[10.5px] uppercase tracking-[0.06em]" style={{ color: "var(--muted)" }}>
                    {["Project", "System", "Total", "Input", "Output", "Cache", "Sessions"].map((h, i) => (
                      <th key={h} className={`px-3 pb-2.5 font-semibold ${i >= 2 ? "text-right" : ""}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(projects.data ?? []).map((p) => (
                    <tr key={p.system_id + p.project_name} className="text-[13px]" style={{ borderTop: "1px solid var(--border)" }}>
                      <td className="px-3 py-3 font-medium">{p.project_name}</td>
                      <td className="px-3 py-3" style={{ color: "var(--ink-2)" }}>{nameOf.get(p.system_id) ?? p.system_id.slice(0, 8)}</td>
                      <td className="tnum px-3 py-3 text-right font-semibold">{fmtTokens(p.total_tokens)}</td>
                      <td className="tnum px-3 py-3 text-right" style={{ color: "var(--ink-2)" }}>{fmtTokens(p.input_tokens)}</td>
                      <td className="tnum px-3 py-3 text-right" style={{ color: "var(--ink-2)" }}>{fmtTokens(p.output_tokens)}</td>
                      <td className="tnum px-3 py-3 text-right" style={{ color: "var(--ink-2)" }}>{fmtTokens(p.cache_read_tokens + p.cache_creation_tokens)}</td>
                      <td className="tnum px-3 py-3 text-right" style={{ color: "var(--ink-2)" }}>{p.sessions}</td>
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

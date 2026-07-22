import type { RankingItem } from "../api/types";
import { fmtTokens, systemColor } from "../lib/format";

export function RankingBars({ items }: { items: RankingItem[] }) {
  if (items.length === 0)
    return <div className="py-6 text-sm" style={{ color: "var(--muted)" }}>No usage in this range yet.</div>;
  const max = Math.max(...items.map((i) => i.total_tokens), 1);
  const colorFor = new Map(items.map((it, i) => [it.system_id, systemColor(i)]));

  return (
    <div>
      {items.map((it, i) => (
        <div key={it.system_id}
          className="grid items-center gap-3 py-2.5"
          style={{ gridTemplateColumns: "150px 1fr auto", borderTop: i ? "1px solid var(--border)" : "none" }}>
          <div className="flex items-center gap-2.5">
            <span className="h-3 w-3 flex-none rounded-[3px]" style={{ background: colorFor.get(it.system_id) }} />
            <span className="text-[13.5px] font-semibold">{it.display_name}</span>
          </div>
          <div className="h-6 overflow-hidden rounded-md" style={{ background: "var(--surface-2)" }}>
            <div className="h-full rounded-md transition-[width] duration-500"
              style={{ width: `${(it.total_tokens / max) * 100}%`, background: colorFor.get(it.system_id), minWidth: 3 }} />
          </div>
          <div className="min-w-[120px] text-right">
            <span className="tnum text-[14px] font-semibold">{fmtTokens(it.total_tokens)}</span>
            {i === 0 && (
              <span className="ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-bold text-white"
                style={{ background: colorFor.get(it.system_id) }}>▲ Highest</span>
            )}
            <div className="tnum text-[11.5px]" style={{ color: "var(--ink-2)" }}>{it.pct}% of fleet</div>
          </div>
        </div>
      ))}
    </div>
  );
}

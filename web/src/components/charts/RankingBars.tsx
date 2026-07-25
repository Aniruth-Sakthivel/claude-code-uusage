/**
 * "Which PC uses the most" ranking — the product's headline view.
 *
 * Two fixes: colors are now keyed to the system id (they previously shifted as
 * ranks changed), and the percentage is labelled honestly. For a scoped user the
 * denominator is only the systems they can see, so calling it "% of fleet"
 * was wrong.
 */

import type { RankingItem } from "../../api/types";
import { fmtTokens, systemColor } from "../../lib/format";
import { EmptyState } from "../ui";

export function RankingBars({
  items,
  scoped = false,
}: {
  items: RankingItem[];
  scoped?: boolean;
}) {
  if (items.length === 0) {
    return <EmptyState title="No usage in this range yet" />;
  }

  const max = Math.max(...items.map((i) => i.total_tokens), 1);
  const shareLabel = scoped ? "of your systems" : "of fleet";

  return (
    <ul className="flex flex-col">
      {items.map((it, i) => {
        const color = systemColor(i);
        return (
          <li
            key={it.system_id}
            className={`grid items-center gap-3 py-2.5 sm:grid-cols-[150px_1fr_auto] ${
              i ? "border-t border-line" : ""
            }`}
          >
            <div className="flex items-center gap-2.5">
              <span
                className="h-3 w-3 flex-none rounded-[3px]"
                style={{ background: color }}
                aria-hidden
              />
              <span className="truncate text-base font-semibold">{it.display_name}</span>
            </div>

            <div className="h-6 overflow-hidden rounded-md bg-surface-2">
              <div
                className="h-full rounded-md transition-[width] duration-500"
                style={{
                  width: `${(it.total_tokens / max) * 100}%`,
                  background: color,
                  minWidth: 3,
                }}
              />
            </div>

            <div className="flex items-baseline gap-2 sm:block sm:min-w-[130px] sm:text-right">
              <span className="tnum text-base font-semibold">
                {fmtTokens(it.total_tokens)}
              </span>
              {i === 0 && items.length > 1 && (
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-bold text-white sm:ml-2"
                  style={{ background: color }}
                >
                  Highest
                </span>
              )}
              <div className="tnum text-xs text-muted">
                {it.pct}% {shareLabel}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

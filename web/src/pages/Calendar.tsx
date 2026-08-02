/**
 * Workspace calendar: a month grid of every task/milestone due date across
 * every initiative (PM is open to every user, so there's no per-user scoping
 * here — see services/pm.ts `getCalendar`).
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { CalendarItem } from "../api/types";
import { Badge, Button, Card, ErrorState, LoadingState } from "../components/ui";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 6 weeks x 7 days covering the given month, including the lead-in/trail-out
 * days from the adjacent months — a standard calendar grid. */
function buildGrid(year: number, month: number): Date[] {
  const first = new Date(Date.UTC(year, month, 1));
  const startOffset = first.getUTCDay();
  const gridStart = new Date(first);
  gridStart.setUTCDate(1 - startOffset);

  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setUTCDate(gridStart.getUTCDate() + i);
    return d;
  });
}

export function Calendar() {
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getUTCFullYear());
  const [month, setMonth] = useState(today.getUTCMonth());

  useEffect(() => {
    document.title = "Calendar — Workspace";
  }, []);

  const q = useQuery({
    queryKey: qk.calendar,
    queryFn: () => api.get<CalendarItem[]>("/workspace/calendar"),
  });

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of q.data ?? []) {
      const list = map.get(item.due_date) ?? [];
      list.push(item);
      map.set(item.due_date, list);
    }
    return map;
  }, [q.data]);

  const grid = useMemo(() => buildGrid(year, month), [year, month]);
  const todayStr = ymd(today);
  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  const goto = (delta: number) => {
    const d = new Date(Date.UTC(year, month + delta, 1));
    setYear(d.getUTCFullYear());
    setMonth(d.getUTCMonth());
  };

  if (q.isLoading) return <LoadingState />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{monthLabel}</h2>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="subtle"
            onClick={() => {
              setYear(today.getUTCFullYear());
              setMonth(today.getUTCMonth());
            }}
          >
            Today
          </Button>
          <Button size="sm" variant="ghost" onClick={() => goto(-1)} aria-label="Previous month">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => goto(1)} aria-label="Next month">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Card className="p-0">
        <div className="grid grid-cols-7 border-b border-line">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-2 text-center text-xs font-semibold text-muted">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.map((d) => {
            const key = ymd(d);
            const inMonth = d.getUTCMonth() === month;
            const items = byDay.get(key) ?? [];
            return (
              <div
                key={key}
                className={`min-h-[6.5rem] border-b border-r border-line p-1.5 last:border-r-0 ${
                  inMonth ? "" : "bg-surface-2/40"
                }`}
              >
                <div
                  className={`mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                    key === todayStr ? "bg-accent font-semibold text-white" : "text-muted"
                  } ${inMonth ? "" : "opacity-50"}`}
                >
                  {d.getUTCDate()}
                </div>
                <div className="flex flex-col gap-1">
                  {items.slice(0, 3).map((item) => (
                    <Link
                      key={`${item.kind}-${item.id}`}
                      to={`/workspace/initiatives/${item.initiative_id}`}
                      className="block truncate rounded px-1.5 py-0.5 text-2xs hover:bg-surface-2"
                      title={`${item.title} — ${item.initiative_name}`}
                    >
                      <Badge tone={item.kind === "milestone" ? "accent" : "neutral"}>
                        {item.kind === "milestone" ? "M" : "T"}
                      </Badge>{" "}
                      {item.title}
                    </Link>
                  ))}
                  {items.length > 3 && (
                    <span className="px-1.5 text-2xs text-muted">+{items.length - 3} more</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

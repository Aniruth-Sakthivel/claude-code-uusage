/**
 * Notification bell: unread badge + dropdown panel. No existing dropdown
 * primitive in ui.tsx, so this is a small self-contained one (click-outside
 * + Escape to close), scoped to this one use.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { Notification } from "../api/types";
import { fmtRelative } from "../lib/format";
import { Button, EmptyState, LoadingState } from "./ui";

export function NotificationsBell() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const unread = useQuery({
    queryKey: qk.unreadCount,
    queryFn: () => api.get<{ count: number }>("/notifications/unread-count"),
    refetchInterval: 30_000,
  });

  const list = useQuery({
    queryKey: qk.notifications,
    queryFn: () => api.get<Notification[]>("/notifications"),
    enabled: open,
  });

  const markRead = useMutation({
    mutationFn: (id: number) => api.post(`/notifications/${id}/read`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.notifications });
      qc.invalidateQueries({ queryKey: qk.unreadCount });
    },
  });

  const markAllRead = useMutation({
    mutationFn: () => api.post("/notifications/read-all"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.notifications });
      qc.invalidateQueries({ queryKey: qk.unreadCount });
    },
  });

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const count = unread.data?.count ?? 0;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${count > 0 ? ` (${count} unread)` : ""}`}
        className="relative rounded-full border border-line bg-surface-2 p-2 text-ink-2"
      >
        <Bell className="h-4 w-4" />
        {count > 0 && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-critical px-1 text-[10px] font-semibold text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 z-40 mt-2 w-80 rounded-2xl border border-line bg-surface p-3 shadow-[var(--shadow)]"
          style={{ animation: "cf-fade-in 0.15s ease-out" }}
        >
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Notifications</h3>
            {count > 0 && (
              <Button size="sm" variant="subtle" onClick={() => markAllRead.mutate()}>
                Mark all read
              </Button>
            )}
          </div>

          {list.isLoading ? (
            <LoadingState />
          ) : (list.data?.length ?? 0) === 0 ? (
            <EmptyState title="You're all caught up" />
          ) : (
            <div className="flex max-h-96 flex-col gap-1 overflow-y-auto">
              {list.data!.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    if (!n.read_at) markRead.mutate(n.id);
                    setOpen(false);
                    if (n.link) navigate(n.link);
                  }}
                  className={`rounded-lg p-2.5 text-left text-sm transition hover:bg-surface-2 ${
                    n.read_at ? "" : "bg-accent-weak/40"
                  }`}
                >
                  <div className="font-medium">{n.title}</div>
                  {n.body && <div className="mt-0.5 truncate text-xs text-muted">{n.body}</div>}
                  <div className="mt-1 text-2xs text-muted">{fmtRelative(n.created_at)}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

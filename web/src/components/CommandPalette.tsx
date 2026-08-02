/**
 * Ctrl/Cmd+K command palette + search, scoped to the Workspace domain
 * (initiatives/tasks/docs/channels — see routes/pm.ts `search`). Mounted
 * once in WorkspaceShell so it's reachable from anywhere in the Workspace
 * app.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, Hash, ListTodo, Search } from "lucide-react";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { SearchResult } from "../api/types";

const KIND_ICON: Record<SearchResult["kind"], typeof Search> = {
  initiative: ListTodo,
  task: ListTodo,
  doc: FileText,
  channel: Hash,
};

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    // The header's visible "Search" button can't reach this component's
    // local state directly (it lives elsewhere in WorkspaceShell), so it
    // opens the palette via this event instead of lifting state up.
    const onOpenRequest = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("workspace-search:open", onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("workspace-search:open", onOpenRequest);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // Wait a tick for the input to mount before focusing.
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const results = useQuery({
    queryKey: qk.search(query),
    queryFn: () => api.get<SearchResult[]>(`/workspace/search?q=${encodeURIComponent(query)}`),
    enabled: open && query.trim().length >= 2,
  });

  const items = results.data ?? [];

  useEffect(() => setActiveIndex(0), [items.length]);

  const go = (item: SearchResult) => {
    setOpen(false);
    navigate(item.link);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search workspace"
        className="w-full max-w-lg rounded-2xl border border-line bg-surface shadow-[var(--shadow)]"
        style={{ animation: "cf-fade-in 0.15s ease-out" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Search className="h-4 w-4 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && items[activeIndex]) {
                go(items[activeIndex]);
              }
            }}
            placeholder="Search initiatives, tasks, docs, channels…"
            className="w-full bg-transparent text-base text-ink outline-none placeholder:text-muted"
          />
          <kbd className="rounded border border-line px-1.5 py-0.5 text-2xs text-muted">Esc</kbd>
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5">
          {query.trim().length < 2 ? (
            <p className="p-3 text-sm text-muted">Type at least 2 characters to search.</p>
          ) : results.isLoading ? (
            <p className="p-3 text-sm text-muted">Searching…</p>
          ) : items.length === 0 ? (
            <p className="p-3 text-sm text-muted">No matches.</p>
          ) : (
            items.map((item, i) => {
              const Icon = KIND_ICON[item.kind];
              return (
                <button
                  key={`${item.kind}-${item.id}`}
                  onClick={() => go(item)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm ${
                    i === activeIndex ? "bg-surface-2" : ""
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <span className="shrink-0 text-xs text-muted">{item.subtitle}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

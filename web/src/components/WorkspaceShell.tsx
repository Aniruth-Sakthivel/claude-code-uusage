/**
 * Workspace: a distinct app shell (own sidebar, own branding, own header),
 * not nested inside Meterhouse's <Layout>/sidebar. It shares the same
 * backend, login session, and React app/router/build as Meterhouse — this is
 * the "same repo/domain, separate app" shape, not a second deployment — but
 * visually and structurally it reads as its own product once you're in it.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { ArrowLeft, BarChart3, BookOpen, CalendarDays, ListTodo, Menu, MessageSquare, PenTool, Search, UserRound, Zap } from "lucide-react";

import { useAuth } from "../auth/AuthContext";
import { CommandPalette } from "./CommandPalette";
import { NotificationsBell } from "./NotificationsBell";
import { ThemeToggle } from "../lib/theme";

interface WorkspaceNavItem {
  to: string;
  label: string;
  icon: typeof ListTodo;
  end?: boolean;
}

const NAV: WorkspaceNavItem[] = [
  { to: "/workspace", label: "Project management", icon: ListTodo, end: true },
  { to: "/workspace/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/workspace/chat", label: "Chat", icon: MessageSquare },
  { to: "/workspace/wiki", label: "Wiki", icon: BookOpen },
  { to: "/workspace/whiteboard", label: "Whiteboard", icon: PenTool },
  { to: "/workspace/reports", label: "Reports", icon: BarChart3 },
  { to: "/workspace/automations", label: "Automations", icon: Zap },
];

function WorkspaceBrand() {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-accent text-sm font-semibold text-white"
        aria-hidden
      >
        W
      </div>
      <div>
        <div className="text-[15px] font-semibold leading-tight text-ink">Workspace</div>
        <div className="text-2xs text-muted">Project management</div>
      </div>
    </div>
  );
}

function Sidebar({ children }: { children?: ReactNode }) {
  const { user, logout } = useAuth();
  const location = useLocation();

  return (
    <nav className="flex h-full flex-col p-4" aria-label="Workspace">
      <div className="mb-5 px-2 pt-1">
        <WorkspaceBrand />
      </div>

      <Link
        to="/dashboard"
        className="mb-4 flex items-center gap-2 rounded-[12px] px-3 py-2 text-sm text-ink-2 transition hover:bg-surface-2"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to Meterhouse
      </Link>

      <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
        <div className="faceplate px-2 pb-1 pt-2 text-2xs text-muted">Workspace</div>
        {NAV.map((n) => {
          const active = n.end ? location.pathname === n.to : location.pathname.startsWith(n.to);
          return (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={`flex items-center gap-2 rounded-[12px] px-3 py-2.5 text-sm transition ${
                active
                  ? "bg-surface text-ink shadow-[0_8px_24px_rgba(0,0,0,0.04)]"
                  : "text-ink-2 hover:bg-surface-2"
              }`}
            >
              <n.icon className="h-4 w-4" />
              <span>{n.label}</span>
            </NavLink>
          );
        })}
      </div>

      <div className="mt-4 rounded-[16px] border border-line bg-surface p-3">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-full bg-surface-2 text-ink-2">
            <UserRound className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ink">
              {user?.full_name || user?.email}
            </div>
            <div className="truncate text-xs capitalize text-muted">{user?.role}</div>
          </div>
        </div>
        <button
          onClick={logout}
          className="mt-3 w-full rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-left text-sm text-ink-2 transition hover:text-ink"
        >
          Sign out
        </button>
      </div>
      {children}
    </nav>
  );
}

export function WorkspaceShell() {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setNavOpen(false), [location.pathname]);

  return (
    <div className="min-h-screen bg-plane lg:grid lg:grid-cols-[260px_1fr]">
      <aside className="sticky top-0 hidden h-screen border-r border-line bg-[var(--surface-2)] lg:block">
        <Sidebar />
      </aside>

      {navOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setNavOpen(false)} aria-hidden />
          <aside className="absolute left-0 top-0 h-full w-[270px] border-r border-line bg-[var(--surface-2)]">
            <Sidebar />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-col">
        <header className="border-b border-line bg-surface/70 px-4 py-3 backdrop-blur sm:px-7 lg:px-8">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-label="Open navigation"
              aria-expanded={navOpen}
              className="rounded-full border border-line bg-surface-2 p-2 text-ink-2 lg:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new Event("workspace-search:open"))}
              className="hidden items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 sm:flex"
            >
              <Search className="h-4 w-4" />
              <span>Search</span>
              <kbd className="ml-2 rounded border border-line px-1.5 text-2xs text-muted">⌘K</kbd>
            </button>

            <div className="flex items-center gap-2">
              <NotificationsBell />
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 pb-12 pt-5 sm:px-7 lg:px-8">
          <Outlet />
        </main>
      </div>

      <CommandPalette />
    </div>
  );
}

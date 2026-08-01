import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Bell, Building2, ChevronRight, Compass, Cpu, FolderKanban, KeyRound, LayoutGrid, Menu, MonitorPlay, Search, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, UserRound } from "lucide-react";

import { useAuth } from "../auth/AuthContext";
import type { Capability } from "../api/types";
import { ThemeToggle } from "../lib/theme";

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  cap?: Capability;
  icon?: typeof LayoutGrid;
}

const MONITOR: NavItem[] = [
  { to: "/dashboard", label: "Overview", end: true, icon: LayoutGrid },
  { to: "/systems", label: "Systems", icon: Cpu },
  { to: "/accounts", label: "Claude accounts", cap: "view_all", icon: KeyRound },
  { to: "/projects", label: "Projects", icon: FolderKanban },
  { to: "/sessions", label: "Sessions", icon: MonitorPlay },
];

const SETUP: NavItem[] = [
  { to: "/connect", label: "Connect a PC", icon: Building2 },
  { to: "/settings", label: "Settings", icon: Settings2 },
];

const ADMIN: NavItem[] = [
  { to: "/admin/users", label: "Users & roles", cap: "manage_users", icon: UserRound },
  { to: "/admin/keys", label: "Agent API keys", cap: "manage_keys", icon: ShieldCheck },
  { to: "/admin/audit", label: "Audit log", cap: "view_audit", icon: Compass },
  { to: "/admin/settings", label: "Fleet settings", cap: "manage_users", icon: SlidersHorizontal },
];

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-accent/20 bg-surface text-sm font-semibold text-accent" aria-hidden>
        A
      </div>
      {!compact && (
        <div>
          <div className="text-[15px] font-semibold leading-tight text-ink">Meterhouse</div>
          <div className="text-2xs text-muted">Private observatory</div>
        </div>
      )}
    </div>
  );
}

function NavSection({ title, items }: { title: string; items: NavItem[] }) {
  if (items.length === 0) return null;
  return (
    <>
      {/* `.faceplate` is the shared uppercase label treatment (see index.css),
          so section headers match column headers and eyebrows elsewhere. */}
      <div className="faceplate px-2 pb-1 pt-4 text-2xs text-muted">{title}</div>
      {items.map((n) => {
        const Icon = n.icon ?? LayoutGrid;
        return (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-[12px] px-3 py-2.5 text-sm transition ${
                isActive
                  ? "bg-surface text-ink shadow-[0_8px_24px_rgba(0,0,0,0.04)]"
                  : "text-ink-2 hover:bg-surface-2"
              }`
            }
          >
            <Icon className="h-4 w-4" />
            <span>{n.label}</span>
          </NavLink>
        );
      })}
    </>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout, can } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setNavOpen(false), [location.pathname]);

  // Every section honours `cap` — a nav link the user would only be
  // redirected away from is worse than no link at all.
  const visible = (items: NavItem[]) => items.filter((i) => !i.cap || can(i.cap));
  const monitorItems = visible(MONITOR);
  const adminItems = visible(ADMIN);

  const sidebar = (
    <nav className="flex h-full flex-col p-4" aria-label="Main">
      <div className="mb-5 px-2 pt-1">
        <Brand />
      </div>

      <div className="mb-4 rounded-[14px] border border-line bg-surface px-3 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">
          <Sparkles className="h-3.5 w-3.5" />
          Quiet luxury mode
        </div>
        <div className="mt-2 text-sm text-ink-2">Calm, precise, and beautifully composed.</div>
      </div>

      {/* The nav scrolls on its own, starting above the first section label.
          The brand above and the account card below stay pinned, so a short
          viewport or a long admin nav can never push either out of reach.
          `min-h-0` is required — without it a flex child refuses to shrink and
          the overflow never engages. */}
      <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
        <NavSection title="Monitor" items={monitorItems} />
        <NavSection title="Setup" items={SETUP} />
        <NavSection title="Admin" items={adminItems} />
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
    </nav>
  );

  return (
    <div className="min-h-screen bg-plane lg:grid lg:grid-cols-[260px_1fr]">
      <aside className="sticky top-0 hidden h-screen border-r border-line bg-[var(--surface-2)] lg:block">
        {sidebar}
      </aside>

      {navOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setNavOpen(false)} aria-hidden />
          <aside className="absolute left-0 top-0 h-full w-[270px] border-r border-line bg-[var(--surface-2)]">
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-col">
        <header className="border-b border-line bg-surface/70 px-4 py-3 backdrop-blur sm:px-7 lg:px-8">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setNavOpen(true)}
                aria-label="Open navigation"
                aria-expanded={navOpen}
                className="rounded-full border border-line bg-surface-2 p-2 text-ink-2 lg:hidden"
              >
                <Menu className="h-4 w-4" />
              </button>
              <div className="hidden text-sm text-muted sm:flex sm:items-center sm:gap-2">
                <span className="font-medium text-ink">Workspace</span>
                <ChevronRight className="h-4 w-4" />
                <span>Operations</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="hidden items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 sm:flex">
                <Search className="h-4 w-4" />
                <span>Search</span>
              </div>
              <button className="rounded-full border border-line bg-surface-2 p-2 text-ink-2">
                <Bell className="h-4 w-4" />
              </button>
              <ThemeToggle />
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 pb-12 pt-5 sm:px-7 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}

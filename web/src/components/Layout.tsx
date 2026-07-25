/**
 * App shell.
 *
 * Responsive: the previous version used a fixed 236px sidebar with no
 * breakpoint, so the whole console was unusable below ~900px. Below `lg` the
 * sidebar becomes a slide-over drawer.
 *
 * Nav items are gated on server-provided capabilities, so a manager or viewer
 * sees exactly what they can actually use.
 */

import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import type { Capability } from "../api/types";
import { ThemeToggle } from "../lib/theme";

interface NavItem {
  to: string;
  label: string;
  end?: boolean;
  cap?: Capability;
}

const MONITOR: NavItem[] = [
  { to: "/dashboard", label: "Overview", end: true },
  { to: "/systems", label: "Systems" },
  { to: "/projects", label: "Projects" },
  { to: "/sessions", label: "Sessions" },
];

const SETUP: NavItem[] = [{ to: "/connect", label: "Connect a PC" }];

const ADMIN: NavItem[] = [
  { to: "/admin/users", label: "Users & roles", cap: "manage_users" },
  { to: "/admin/keys", label: "Agent API keys", cap: "manage_keys" },
  { to: "/admin/audit", label: "Audit log", cap: "view_audit" },
];

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-bold text-white"
        style={{ background: "linear-gradient(135deg, var(--pc1), var(--accent))" }}
        aria-hidden
      >
        CF
      </div>
      {!compact && (
        <div>
          <div className="text-lg font-semibold leading-tight">ClaudeFleet</div>
          <div className="text-2xs text-muted">Usage monitor</div>
        </div>
      )}
    </div>
  );
}

function NavSection({ title, items }: { title: string; items: NavItem[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <div className="px-2 pb-1 pt-4 text-2xs font-semibold uppercase tracking-[0.09em] text-muted">
        {title}
      </div>
      {items.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          className={({ isActive }) =>
            `block rounded-lg px-3 py-2 text-base transition ${
              isActive
                ? "bg-accent-weak font-semibold text-accent"
                : "font-medium text-ink-2 hover:bg-surface-2"
            }`
          }
        >
          {n.label}
        </NavLink>
      ))}
    </>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout, can } = useAuth();
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  // Close the drawer on navigation.
  useEffect(() => setNavOpen(false), [location.pathname]);

  const adminItems = ADMIN.filter((i) => !i.cap || can(i.cap));

  const sidebar = (
    <nav className="flex h-full flex-col gap-0.5 p-4" aria-label="Main">
      <div className="mb-2 px-2 pt-1">
        <Brand />
      </div>

      <NavSection title="Monitor" items={MONITOR} />
      <NavSection title="Setup" items={SETUP} />
      <NavSection title="Admin" items={adminItems} />

      <div className="mt-auto border-t border-line pt-3">
        <div className="truncate px-2 text-sm font-medium">
          {user?.full_name || user?.email}
        </div>
        <div className="px-2 text-xs capitalize text-muted">{user?.role}</div>
        <button
          onClick={logout}
          className="mt-2 w-full rounded-lg bg-surface-2 px-3 py-1.5 text-left text-sm text-ink-2 hover:text-ink"
        >
          Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[236px_1fr]">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen border-r border-line bg-surface lg:block">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {navOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setNavOpen(false)}
            aria-hidden
          />
          <aside className="absolute left-0 top-0 h-full w-[260px] border-r border-line bg-surface">
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3 sm:px-7 lg:justify-end lg:border-b-0 lg:pt-5">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={navOpen}
            className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-ink-2 lg:hidden"
          >
            ☰
          </button>
          <div className="lg:hidden">
            <Brand compact />
          </div>
          <div className="ml-auto lg:ml-0">
            <ThemeToggle />
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 pb-12 pt-4 sm:px-7">
          {children}
        </main>
      </div>
    </div>
  );
}

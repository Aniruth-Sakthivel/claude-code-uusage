/**
 * Client portal shell — a third distinct app (after Meterhouse's Layout and
 * the internal WorkspaceShell), for external client-role accounts. Minimal
 * nav on purpose: a client only ever has one thing to do here, look at the
 * initiatives shared with them.
 */

import { Outlet } from "react-router-dom";

import { useAuth } from "../auth/AuthContext";
import { ThemeToggle } from "../lib/theme";

export function ClientPortalShell() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-plane">
      <header className="border-b border-line bg-surface/70 px-4 py-3 backdrop-blur sm:px-7">
        <div className="mx-auto flex w-full max-w-[1000px] items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div
              className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-accent text-sm font-semibold text-white"
              aria-hidden
            >
              P
            </div>
            <div>
              <div className="text-[15px] font-semibold leading-tight text-ink">Client Portal</div>
              <div className="text-2xs text-muted">{user?.full_name || user?.email}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button
              onClick={logout}
              className="rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 transition hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1000px] px-4 pb-12 pt-6 sm:px-7">
        <Outlet />
      </main>
    </div>
  );
}

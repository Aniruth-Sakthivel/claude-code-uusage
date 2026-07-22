import { type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../lib/useTheme";

const NAV = [
  { to: "/dashboard", label: "Overview", end: true },
  { to: "/systems", label: "Systems" },
  { to: "/projects", label: "Projects" },
];
const ADMIN_NAV = [
  { to: "/admin/users", label: "Users & roles", cap: "manage_users" as const },
  { to: "/admin/keys", label: "Agent API keys", cap: "manage_keys" as const },
  { to: "/admin/audit", label: "Audit log", cap: "view_audit" as const },
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout, can } = useAuth();
  const { dark, toggle } = useTheme();
  const adminItems = ADMIN_NAV.filter((i) => can(i.cap));

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `block rounded-lg px-3 py-2 text-[13.5px] font-medium transition ${isActive ? "font-semibold" : ""}`;
  const linkStyle = (isActive: boolean) =>
    isActive ? { background: "var(--accent-weak)", color: "var(--accent)" } : { color: "var(--ink-2)" };

  return (
    <div className="grid min-h-screen" style={{ gridTemplateColumns: "236px 1fr" }}>
      <aside className="sticky top-0 flex h-screen flex-col gap-1 border-r p-4"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}>
        <div className="mb-4 flex items-center gap-2.5 px-2 pt-1">
          <div className="grid h-8 w-8 place-items-center rounded-lg text-[14px] font-bold text-white"
            style={{ background: "linear-gradient(135deg, var(--pc1), var(--accent))" }}>CF</div>
          <div>
            <div className="text-[15px] font-semibold leading-tight">ClaudeFleet</div>
            <div className="text-[11px]" style={{ color: "var(--muted)" }}>Usage monitor</div>
          </div>
        </div>

        <div className="px-2 pb-1 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.09em]" style={{ color: "var(--muted)" }}>Monitor</div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={linkClass}
            style={({ isActive }) => linkStyle(isActive)}>{n.label}</NavLink>
        ))}

        {adminItems.length > 0 && (
          <>
            <div className="px-2 pb-1 pt-4 text-[10.5px] font-semibold uppercase tracking-[0.09em]" style={{ color: "var(--muted)" }}>Admin</div>
            {adminItems.map((n) => (
              <NavLink key={n.to} to={n.to} className={linkClass}
                style={({ isActive }) => linkStyle(isActive)}>{n.label}</NavLink>
            ))}
          </>
        )}

        <div className="mt-auto border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <div className="px-2 text-[12px] font-medium">{user?.full_name || user?.email}</div>
          <div className="px-2 text-[11px] capitalize" style={{ color: "var(--muted)" }}>{user?.role}</div>
          <button onClick={logout} className="mt-2 w-full rounded-lg px-3 py-1.5 text-left text-[12.5px]"
            style={{ background: "var(--surface-2)", color: "var(--ink-2)" }}>Sign out</button>
        </div>
      </aside>

      <div className="flex flex-col">
        <header className="flex items-center justify-end gap-3 px-7 pt-5">
          <button onClick={toggle} aria-label="Toggle theme"
            className="grid h-9 w-9 place-items-center rounded-lg border"
            style={{ background: "var(--surface)", borderColor: "var(--border)", color: "var(--ink-2)" }}>
            {dark ? "☀" : "☾"}
          </button>
        </header>
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-7 pb-12 pt-3">{children}</main>
      </div>
    </div>
  );
}

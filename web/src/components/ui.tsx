import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl border p-5 ${className}`}
      style={{ background: "var(--surface)", borderColor: "var(--border)", boxShadow: "var(--shadow)" }}
    >
      {children}
    </div>
  );
}

export function CardHead({ title, hint, right }: { title: string; hint?: string; right?: ReactNode }) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-3">
      <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
      {right ?? (hint && <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>{hint}</span>)}
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const online = status === "online";
  const color = online ? "var(--good)" : "var(--critical)";
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color }}>
      <span className="h-2 w-2 rounded-full" style={{ background: "currentColor" }} />
      {online ? "Online" : "Offline"}
    </span>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="text-[10.5px] font-semibold uppercase tracking-[0.07em]" style={{ color: "var(--muted)" }}>
      {children}
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <div className="p-8 text-center text-sm" style={{ color: "var(--muted)" }}>{label}</div>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="p-10 text-center">
      <div className="text-sm font-medium">{title}</div>
      {hint && <div className="mt-1 text-[13px]" style={{ color: "var(--muted)" }}>{hint}</div>}
    </div>
  );
}

export function Button({ children, onClick, variant = "primary", type = "button", disabled }: {
  children: ReactNode; onClick?: () => void; variant?: "primary" | "ghost" | "danger";
  type?: "button" | "submit"; disabled?: boolean;
}) {
  const base = "rounded-lg px-3.5 py-2 text-[13px] font-semibold transition disabled:opacity-50";
  const styles =
    variant === "primary" ? { background: "var(--accent)", color: "#fff" }
    : variant === "danger" ? { background: "var(--critical)", color: "#fff" }
    : { background: "var(--surface-2)", color: "var(--ink)" };
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={base} style={styles}>
      {children}
    </button>
  );
}

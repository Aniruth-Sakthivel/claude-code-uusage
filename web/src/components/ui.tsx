/**
 * UI primitives.
 *
 * Everything a page needs to render a form, a table, a state, or a dialog.
 * The previous version had only 7 components and no Table/Input/Select, which
 * is why input styling was copy-pasted across five pages and table markup
 * across five more.
 */

import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

// ── layout ────────────────────────────────────────────────────────────────────
const cardClass = "rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow)]";

export function Card({
  children,
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div {...rest} className={`${cardClass} ${className}`}>
      {children}
    </div>
  );
}

/** Card rendered as a <form>, so submit/Enter works without prop-forwarding hacks. */
export function FormCard({
  children,
  className = "",
  ...rest
}: FormHTMLAttributes<HTMLFormElement> & { children: ReactNode }) {
  return (
    <form {...rest} className={`${cardClass} ${className}`}>
      {children}
    </form>
  );
}

export function CardHead({
  title,
  hint,
  right,
}: {
  title: ReactNode;
  hint?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      {right ?? (hint && <span className="text-xs text-muted">{hint}</span>)}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="text-2xs font-semibold uppercase tracking-[0.07em] text-muted">
      {children}
    </div>
  );
}

// ── button ────────────────────────────────────────────────────────────────────
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "subtle";
  size?: "sm" | "md";
  loading?: boolean;
};

/** forwardRef so dialogs can move focus to the confirm button. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { children, variant = "primary", size = "md", loading = false, disabled, className = "", ...rest },
  ref,
) {
  const sizes = size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm";
  const variants: Record<string, string> = {
    primary: "bg-accent text-white hover:opacity-90",
    danger: "bg-critical text-white hover:opacity-90",
    ghost: "bg-surface-2 text-ink hover:opacity-80",
    subtle: "bg-transparent text-ink-2 hover:bg-surface-2",
  };
  return (
    <button
      {...rest}
      ref={ref}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${sizes} ${variants[variant]} ${className}`}
    >
      {loading && <Spinner size={14} />}
      {children}
    </button>
  );
});

// ── form controls ─────────────────────────────────────────────────────────────
const controlClass =
  "w-full rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-base text-ink " +
  "placeholder:text-muted disabled:opacity-60";

/**
 * Labelled field wrapper. Generates the id/label association so inputs are
 * never placeholder-only, which is how the old admin form shipped.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (props: { id: string; "aria-describedby"?: string }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-semibold text-ink-2">
        {label}
        {required && <span className="ml-0.5 text-critical">*</span>}
      </label>
      {children({ id, "aria-describedby": describedBy })}
      {error ? (
        <p id={`${id}-err`} className="text-xs text-critical">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return <input {...rest} className={`${controlClass} ${className}`} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = "", ...rest } = props;
  return <textarea {...rest} className={`${controlClass} ${className}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = "", children, ...rest } = props;
  return (
    <select {...rest} className={`${controlClass} ${className}`}>
      {children}
    </select>
  );
}

// ── status ────────────────────────────────────────────────────────────────────
export function StatusPill({
  status,
  neverSynced,
}: {
  status: string;
  neverSynced?: boolean;
}) {
  if (neverSynced) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-warn">
        <span className="h-2 w-2 rounded-full bg-current" />
        Never synced
      </span>
    );
  }
  const online = status === "online";
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-sm font-semibold ${online ? "text-good" : "text-muted"}`}
    >
      <span className="h-2 w-2 rounded-full bg-current" />
      {online ? "Online" : "Offline"}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "good" | "critical";
}) {
  const tones: Record<string, string> = {
    neutral: "bg-surface-2 text-ink-2",
    accent: "bg-accent-weak text-accent",
    good: "bg-accent-weak text-good",
    critical: "bg-critical-weak text-critical",
  };
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

// ── async states ──────────────────────────────────────────────────────────────
export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="inline-block shrink-0 rounded-full border-2 border-current border-t-transparent opacity-60"
      style={{ width: size, height: size, animation: "cf-spin 0.7s linear infinite" }}
    />
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2.5 p-10 text-base text-muted"
      aria-live="polite"
    >
      <Spinner />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="p-10 text-center">
      <div className="text-base font-medium">{title}</div>
      {hint && <div className="mx-auto mt-1.5 max-w-md text-sm text-muted">{hint}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * Error state. Previously missing entirely — every page rendered its empty
 * state on failure, so "the API is down" looked identical to "no data yet".
 */
export function ErrorState({
  error,
  onRetry,
  title = "Could not load this data",
}: {
  error?: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  return (
    <div className="p-10 text-center" role="alert">
      <div className="text-base font-medium text-critical">{title}</div>
      {message && <div className="mx-auto mt-1.5 max-w-md text-sm text-muted">{message}</div>}
      {onRetry && (
        <div className="mt-4 flex justify-center">
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warn" | "error";
  title?: string;
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    info: "border-line bg-accent-weak text-ink-2",
    warn: "border-line bg-surface-2 text-ink-2",
    error: "border-line bg-critical-weak text-critical",
  };
  return (
    <div className={`rounded-xl border p-3.5 text-sm ${tones[tone]}`} role={tone === "error" ? "alert" : undefined}>
      {title && <div className="mb-0.5 font-semibold">{title}</div>}
      {children}
    </div>
  );
}

// ── table ─────────────────────────────────────────────────────────────────────
/**
 * Table primitives. Wide content scrolls inside its own container so the page
 * body never scrolls horizontally on mobile.
 */
export function Table({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-[520px] border-collapse text-left">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  align = "left",
  sortDir,
  onSort,
}: {
  children: ReactNode;
  align?: "left" | "right";
  /** Present (even as `null`) to render this column as sortable. */
  sortDir?: "asc" | "desc" | null;
  onSort?: () => void;
}) {
  const sortable = onSort !== undefined;
  return (
    <th
      scope="col"
      aria-sort={sortDir === "asc" ? "ascending" : sortDir === "desc" ? "descending" : undefined}
      className={`pb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-muted ${align === "right" ? "text-right" : ""}`}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={`inline-flex items-center gap-1 hover:text-ink-2 ${align === "right" ? "flex-row-reverse" : ""}`}
        >
          {children}
          <span aria-hidden className="text-[0.6rem]">
            {sortDir === "asc" ? "▲" : sortDir === "desc" ? "▼" : "↕"}
          </span>
        </button>
      ) : (
        children
      )}
    </th>
  );
}

/** Prev/next pager for client-side-paginated tables. */
export function Pagination({
  page,
  pageCount,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-muted">
      <span>
        {from}–{to} of {total}
      </span>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="subtle"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="subtle"
          disabled={page >= pageCount - 1}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

export function Td({
  children,
  align = "left",
  className = "",
}: {
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={`border-t border-line py-2.5 text-base ${align === "right" ? "text-right" : ""} ${className}`}
    >
      {children}
    </td>
  );
}

// ── dialog ────────────────────────────────────────────────────────────────────
/**
 * Confirmation dialog. Destructive actions (delete user, revoke key) had no
 * confirmation at all before.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow)]"
        style={{ animation: "cf-fade-in 0.15s ease-out" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        {body && <div className="mt-1.5 text-sm text-muted">{body}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            ref={ref}
            variant={destructive ? "danger" : "primary"}
            size="sm"
            onClick={onConfirm}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── toast ─────────────────────────────────────────────────────────────────────
/**
 * Minimal toast system. Mutation failures previously vanished silently —
 * rotate/revoke had no onError handler at all.
 */
interface Toast {
  id: number;
  message: string;
  tone: "success" | "error";
}

const ToastCtx = createContext<{ push: (message: string, tone?: Toast["tone"]) => void } | null>(
  null,
);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  function push(message: string, tone: Toast["tone"] = "success") {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto max-w-sm rounded-xl border border-line px-3.5 py-2.5 text-sm shadow-[var(--shadow)] ${
              t.tone === "error" ? "bg-critical-weak text-critical" : "bg-surface text-ink"
            }`}
            style={{ animation: "cf-fade-in 0.15s ease-out" }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

// ── misc ──────────────────────────────────────────────────────────────────────
/** Copy-to-clipboard code block with feedback. */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The old implementation leaked this timer on unmount.
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the text is still selectable */
    }
  }

  return (
    <div className="relative">
      {label && <div className="mb-1.5 text-xs font-semibold text-ink-2">{label}</div>}
      <pre className="overflow-x-auto rounded-xl border border-line bg-surface-2 p-3 pr-20 text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 rounded-md bg-surface px-2 py-1 text-xs font-semibold text-ink-2 hover:text-ink"
        style={{ top: label ? "2.1rem" : "0.5rem" }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

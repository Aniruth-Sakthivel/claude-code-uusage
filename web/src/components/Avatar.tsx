/**
 * Initials avatar — this app has no avatar-image field anywhere, so a name or
 * email is always reduced to initials in a coloured circle instead.
 */

/** Splits "Alex Kim" or "alex.kim@co.com" into "AK". */
export function initialsOf(nameOrEmail: string): string {
  const source = nameOrEmail.trim();
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

const SIZES: Record<"sm" | "md", string> = {
  sm: "h-8 w-8 text-2xs",
  md: "h-10 w-10 text-xs",
};

export function Avatar({
  label,
  size = "sm",
  presence,
}: {
  label: string;
  size?: "sm" | "md";
  presence?: "online" | "offline";
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <span
        className={`grid place-items-center rounded-full bg-surface-2 font-semibold text-ink-2 ${SIZES[size]}`}
      >
        {initialsOf(label)}
      </span>
      {presence && (
        <span
          aria-hidden
          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${
            presence === "online" ? "bg-good" : "bg-muted"
          }`}
        />
      )}
    </span>
  );
}

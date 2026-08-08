/**
 * Avatar — an uploaded image when `src` is set, falling back to initials in a
 * coloured circle otherwise (and if the image fails to load).
 */

import { useState } from "react";

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
  src,
  size = "sm",
  presence,
}: {
  label: string;
  src?: string | null;
  size?: "sm" | "md";
  presence?: "online" | "offline";
}) {
  const [broken, setBroken] = useState(false);

  return (
    <span className="relative inline-flex shrink-0">
      {src && !broken ? (
        <img
          src={src}
          alt=""
          onError={() => setBroken(true)}
          className={`rounded-full object-cover ${SIZES[size]}`}
        />
      ) : (
        <span
          className={`grid place-items-center rounded-full bg-surface-2 font-semibold text-ink-2 ${SIZES[size]}`}
        >
          {initialsOf(label)}
        </span>
      )}
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

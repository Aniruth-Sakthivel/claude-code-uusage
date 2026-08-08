/**
 * The master panel: every person, searchable, with pinned and recent shortcuts.
 *
 * Scales by search + a plain scroll container rather than virtualisation. At
 * a few hundred people the DOM cost is negligible, while windowing would break
 * Ctrl-F and keyboard navigation for no measurable gain.
 */

import { Pin, PinOff } from "lucide-react";
import { useMemo } from "react";

import type { PersonRow } from "../api/types";
import { Avatar } from "./Avatar";
import { ScanTimer } from "./ScanActivity";
import { Badge, Input } from "./ui";
import { fmtRelative, fmtTokens } from "../lib/format";

function PersonButton({
  person,
  selected,
  pinned,
  onSelect,
  onTogglePin,
}: {
  person: PersonRow;
  selected: boolean;
  pinned: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
}) {
  return (
    <div
      className={`group flex items-center gap-2 rounded-xl border px-2 py-2 transition ${
        selected
          ? "border-accent/40 bg-accent-weak"
          : "border-transparent hover:border-line hover:bg-surface-2"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <Avatar
          label={person.full_name || person.email}
          src={person.avatar_url}
          presence={person.status}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-ink">
              {person.full_name || person.email}
            </span>
            {person.plan_label && (
              <Badge tone={person.plan_label.startsWith("Max") ? "accent" : "neutral"}>
                {person.plan_label}
              </Badge>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted">
            <span className="tnum">{fmtTokens(person.tokens_range)}</span>
            <span aria-hidden>·</span>
            <span className="tnum">{fmtRelative(person.last_active)}</span>
            {/* The agent's scan cadence, next to the person whose usage it
                collects — so a row that has stopped updating is visibly a
                stopped agent rather than someone who did no work. */}
            {person.scan && (
              <>
                <span aria-hidden>·</span>
                <ScanTimer scan={person.scan} />
              </>
            )}
          </span>
        </span>
      </button>

      <button
        type="button"
        onClick={onTogglePin}
        title={pinned ? "Unpin" : "Pin to top"}
        aria-label={pinned ? `Unpin ${person.email}` : `Pin ${person.email}`}
        aria-pressed={pinned}
        className={`shrink-0 rounded-lg p-1.5 transition ${
          pinned
            ? "text-accent"
            : "text-muted opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
        }`}
      >
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </button>
    </div>
  );
}

export function PersonList({
  people,
  selectedId,
  pinned,
  recent,
  query,
  onQuery,
  onSelect,
  onTogglePin,
}: {
  people: PersonRow[];
  selectedId: number | null;
  pinned: number[];
  recent: number[];
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: number) => void;
  onTogglePin: (id: number) => void;
}) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter(
      (p) =>
        p.email.toLowerCase().includes(q) ||
        p.full_name.toLowerCase().includes(q) ||
        (p.account_email ?? "").toLowerCase().includes(q),
    );
  }, [people, query]);

  const byId = new Map(people.map((p) => [p.id, p]));
  const pinnedPeople = pinned.map((id) => byId.get(id)).filter(Boolean) as PersonRow[];
  // Recent excludes anything already pinned, so nobody appears twice.
  const recentPeople = recent
    .filter((id) => !pinned.includes(id) && id !== selectedId)
    .map((id) => byId.get(id))
    .filter(Boolean) as PersonRow[];

  const rest = filtered.filter((p) => !pinned.includes(p.id));

  const section = (title: string, rows: PersonRow[]) =>
    rows.length > 0 && (
      <div className="mb-2">
        <div className="faceplate px-2 pb-1 pt-2 text-2xs text-muted">{title}</div>
        <div className="flex flex-col gap-1">
          {rows.map((p) => (
            <PersonButton
              key={p.id}
              person={p}
              selected={p.id === selectedId}
              pinned={pinned.includes(p.id)}
              onSelect={() => onSelect(p.id)}
              onTogglePin={() => onTogglePin(p.id)}
            />
          ))}
        </div>
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2">
        <Input
          type="search"
          placeholder="Search people…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          aria-label="Search people by name or email"
        />
      </div>

      <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
        {/* Pinned and recent are hidden while searching — when you are looking
            for someone specific, shortcuts are noise. */}
        {!query && section("Pinned", pinnedPeople)}
        {!query && section("Recent", recentPeople)}
        {section(query ? "Results" : "Everyone", rest)}

        {filtered.length === 0 && (
          <div className="p-6 text-center text-sm text-muted">No one matches that search.</div>
        )}
      </div>
    </div>
  );
}

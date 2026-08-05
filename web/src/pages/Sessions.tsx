/**
 * Project sessions, organised by person.
 *
 * Master-detail: pick someone on the left, the whole right panel follows.
 * Opens on "All users" so the fleet picture is still the default, and
 * remembers the last person selected so returning lands where you left off.
 *
 * Metadata only — session ids, projects, models, timestamps, token counts, and
 * (where a machine opted in) session titles. Never prompts, responses, or code.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Columns2, X } from "lucide-react";

import { api } from "../api/client";
import { qk } from "../api/queryKeys";
import type { PeopleResponse, PersonRow } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import {
  Alert,
  Button,
  Card,
  CardHead,
  EmptyState,
  ErrorState,
  Eyebrow,
  LoadingState,
} from "../components/ui";
import { PersonList } from "../components/PersonList";
import { PersonDetailPanel } from "../components/PersonDetail";
import { fmtRelative, fmtTokens } from "../lib/format";
import {
  loadLastPerson,
  loadPinned,
  loadRecent,
  pushRecent,
  saveLastPerson,
  togglePinned,
} from "../lib/personPrefs";

const RANGES = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
];

/** Fleet overview, shown when nobody is selected. */
function AllUsers({ people, range }: { people: PersonRow[]; range: string }) {
  const totals = people.reduce(
    (acc, p) => ({
      tokens: acc.tokens + p.tokens_range,
      sessions: acc.sessions + p.sessions,
      online: acc.online + (p.status === "online" ? 1 : 0),
      prompts: p.prompts === null ? acc.prompts : (acc.prompts ?? 0) + p.prompts,
    }),
    { tokens: 0, sessions: 0, online: 0, prompts: null as number | null },
  );

  const ranked = [...people].sort((a, b) => b.tokens_range - a.tokens_range).slice(0, 8);
  const max = ranked[0]?.tokens_range || 1;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHead title="All users" hint={`${people.length} people · ${range}`} />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "People", value: String(people.length) },
            { label: "Online now", value: String(totals.online) },
            { label: "Sessions", value: String(totals.sessions) },
            { label: "Tokens", value: fmtTokens(totals.tokens) },
          ].map((t) => (
            <div key={t.label} className="rounded-xl border border-line p-3">
              <div className="faceplate text-2xs text-muted">{t.label}</div>
              <div className="tnum mt-1 text-lg font-semibold text-ink">{t.value}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHead title="Most active" hint="by tokens in this window" />
        {ranked.length === 0 ? (
          <EmptyState title="No activity in this window" />
        ) : (
          <div className="flex flex-col gap-2">
            {ranked.map((p, i) => (
              <div key={p.id} className="flex items-center gap-3">
                <div className="tnum w-5 shrink-0 text-right text-xs text-muted">{i + 1}</div>
                <div className="w-44 shrink-0 truncate text-sm text-ink-2">
                  {p.full_name || p.email}
                </div>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.max(2, (p.tokens_range / max) * 100)}%` }}
                  />
                </div>
                <div className="tnum w-16 shrink-0 text-right text-sm font-semibold">
                  {fmtTokens(p.tokens_range)}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHead title="Everyone" />
        <div className="grid gap-2 sm:grid-cols-2">
          {people.map((p) => (
            <div key={p.id} className="rounded-xl border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 truncate text-sm font-semibold text-ink">
                  {p.full_name || p.email}
                </div>
                <span
                  aria-hidden
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    p.status === "online" ? "bg-good" : "bg-muted"
                  }`}
                />
              </div>
              <div className="tnum mt-1 text-2xs text-muted">
                {fmtTokens(p.tokens_range)} · {p.sessions} sessions ·{" "}
                {fmtRelative(p.last_active)}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function Sessions() {
  const { user, can } = useAuth();
  const [range, setRange] = useState("30d");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(() => loadLastPerson());
  const [compareWith, setCompareWith] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number[]>(() => loadPinned());
  const [recent, setRecent] = useState<number[]>(() => loadRecent());

  useEffect(() => {
    document.title = "Sessions — Meterhouse";
  }, []);

  // Enumerating people needs view_all; everyone else sees only themselves.
  const canSeeEveryone = can("view_all");

  const q = useQuery({
    queryKey: qk.people(range),
    queryFn: () => api.get<PeopleResponse>(`/people?range=${range}`),
    enabled: canSeeEveryone,
    // Each row carries its agent's live scan state; the countdown ticks
    // locally, but the state behind it has to be refreshed to stay true.
    refetchInterval: 15_000,
  });

  const people = useMemo(() => q.data?.people ?? [], [q.data]);

  // Drop a remembered selection that no longer exists (person deleted, or the
  // caller's scope changed) rather than showing an empty detail panel.
  useEffect(() => {
    if (selected !== null && people.length > 0 && !people.some((p) => p.id === selected)) {
      setSelected(null);
      saveLastPerson(null);
    }
  }, [people, selected]);

  function select(id: number | null) {
    setSelected(id);
    saveLastPerson(id);
    if (id !== null) setRecent(pushRecent(id));
  }

  // Prev/next walk the list as currently ordered, so the buttons agree with
  // what is on screen.
  const order = people.map((p) => p.id);
  const index = selected === null ? -1 : order.indexOf(selected);
  const goto = (delta: number) => {
    if (index < 0) return;
    const next = order[index + delta];
    if (next !== undefined) select(next);
  };

  if (!canSeeEveryone) {
    // A developer can still review their own activity.
    return (
      <div className="flex flex-col gap-5">
        <div>
          <Eyebrow>Analytics</Eyebrow>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">My sessions</h1>
        </div>
        {user && <PersonDetailPanel personId={user.id} range={range} />}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Eyebrow>Analytics</Eyebrow>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Sessions by person</h1>
          <p className="mt-1.5 text-base text-muted">
            Pick someone to filter everything below to their activity.
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Time range"
          className="inline-flex rounded-full border border-line bg-surface-2 p-1"
        >
          {RANGES.map((r) => (
            <button
              key={r.id}
              role="tab"
              aria-selected={range === r.id}
              onClick={() => setRange(r.id)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                range === r.id
                  ? "bg-surface text-ink shadow-[var(--shadow)]"
                  : "text-ink-2 hover:text-ink"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading ? (
        <Card>
          <LoadingState />
        </Card>
      ) : q.isError ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : people.length === 0 ? (
        <Card>
          <EmptyState title="No people yet" hint="Invite someone from Users & roles." />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <Card className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-hidden">
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                onClick={() => select(null)}
                className={`rounded-lg px-2 py-1 text-xs font-semibold transition ${
                  selected === null ? "bg-accent-weak text-accent" : "text-muted hover:text-ink"
                }`}
              >
                All users
              </button>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={index <= 0}
                  onClick={() => goto(-1)}
                  aria-label="Previous person"
                >
                  <ChevronLeft size={14} />
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  disabled={index < 0 || index >= order.length - 1}
                  onClick={() => goto(1)}
                  aria-label="Next person"
                >
                  <ChevronRight size={14} />
                </Button>
              </div>
            </div>

            <div className="lg:h-[calc(100vh-11rem)]">
              <PersonList
                people={people}
                selectedId={selected}
                pinned={pinned}
                recent={recent}
                query={query}
                onQuery={setQuery}
                onSelect={select}
                onTogglePin={(id) => setPinned(togglePinned(id))}
              />
            </div>
          </Card>

          <div className="min-w-0">
            {selected === null ? (
              <AllUsers people={people} range={range} />
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
                  {compareWith === null ? (
                    <Button
                      size="sm"
                      variant="subtle"
                      onClick={() => {
                        // Default the comparison to the next person along, so
                        // one click gives a useful pairing.
                        const other = order.find((id) => id !== selected);
                        if (other !== undefined) setCompareWith(other);
                      }}
                      disabled={people.length < 2}
                    >
                      <Columns2 size={14} /> Compare
                    </Button>
                  ) : (
                    <>
                      <select
                        value={compareWith}
                        onChange={(e) => setCompareWith(Number(e.target.value))}
                        aria-label="Compare with"
                        className="rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink"
                      >
                        {people
                          .filter((p) => p.id !== selected)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.full_name || p.email}
                            </option>
                          ))}
                      </select>
                      <Button size="sm" variant="subtle" onClick={() => setCompareWith(null)}>
                        <X size={14} /> Close comparison
                      </Button>
                    </>
                  )}
                </div>

                {compareWith === null ? (
                  <PersonDetailPanel personId={selected} range={range} />
                ) : (
                  // Two independent panels side by side; each fetches its own
                  // data, so neither blocks the other.
                  <div className="grid gap-4 xl:grid-cols-2">
                    <PersonDetailPanel personId={selected} range={range} />
                    <PersonDetailPanel personId={compareWith} range={range} />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <Alert tone="info">
        Session titles appear only for machines that opted into title sync. Prompt counts start
        from when the agent gained the ability, so older sessions show “—”.
      </Alert>
    </div>
  );
}

/**
 * Per-browser preferences for the people view: which person was last open,
 * which are pinned, and which were viewed recently.
 *
 * localStorage rather than the server because these are workspace habits, not
 * account settings — they should differ between a laptop and a shared screen,
 * and they must be readable synchronously on first render so the page opens on
 * the right person without a flash of the default view.
 */

const LAST_KEY = "mh_people_last";
const PINNED_KEY = "mh_people_pinned";
const RECENT_KEY = "mh_people_recent";
const RECENT_MAX = 5;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback; // private mode or corrupt value — defaults are fine
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* not worth surfacing — the view still works, it just won't persist */
  }
}

export function loadLastPerson(): number | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    const id = raw ? Number(raw) : Number.NaN;
    return Number.isInteger(id) ? id : null;
  } catch {
    return null;
  }
}

export function saveLastPerson(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(LAST_KEY);
    else localStorage.setItem(LAST_KEY, String(id));
  } catch {
    /* ignore */
  }
}

export function loadPinned(): number[] {
  return readJson<number[]>(PINNED_KEY, []);
}

export function togglePinned(id: number): number[] {
  const current = loadPinned();
  const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  writeJson(PINNED_KEY, next);
  return next;
}

export function loadRecent(): number[] {
  return readJson<number[]>(RECENT_KEY, []);
}

/** Most-recent-first, deduplicated, capped. */
export function pushRecent(id: number): number[] {
  const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
  writeJson(RECENT_KEY, next);
  return next;
}

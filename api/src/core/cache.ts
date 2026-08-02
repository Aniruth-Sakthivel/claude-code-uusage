/**
 * In-memory cache manager.
 *
 * Deliberately NOT Redis-backed: this API runs as a stateless Netlify
 * serverless function (one request per invocation, see db/client.ts), so a
 * plain in-process Map only ever helps within a single *warm* function
 * instance — a cold start, a different concurrent instance, or Netlify
 * recycling the container all miss it. That is a real, known limitation, not
 * an oversight: adding Redis would mean provisioning and operating a new
 * piece of infrastructure this small app doesn't otherwise need. Use short
 * TTLs (see DEFAULT_TTL_MS) and only cache data that's safe to serve briefly
 * stale.
 *
 * Never cache per-user-scoped data here without including the scoping key
 * (e.g. user id) in the cache key — this store has no concept of "who is
 * asking," so a flat key like `dashboard:stats` would leak one user's data
 * to the next request that happens to hit the same warm instance. See
 * core/cacheKeys.ts for the keys actually in use and why.
 */

export const DEFAULT_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  tags: string[];
}

export interface CacheSetOptions {
  /** Time-to-live in milliseconds. Default {@link DEFAULT_TTL_MS}. */
  ttlMs?: number;
  /** Tags this entry can be bulk-invalidated by (see invalidateTags). */
  tags?: string[];
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  /** hits / (hits + misses), or 0 with an empty denominator. */
  hitRatio: number;
}

/** Turns a `*`-glob pattern (e.g. "dashboard:*") into an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export class CacheManager {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private hits = 0;
  private misses = 0;

  private isLive(entry: CacheEntry<unknown> | undefined): entry is CacheEntry<unknown> {
    return entry !== undefined && entry.expiresAt > Date.now();
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!this.isLive(entry)) {
      if (entry) this.store.delete(key); // present but expired: sweep it
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value as T;
  }

  set<T>(key: string, value: T, options: CacheSetOptions = {}): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (options.ttlMs ?? DEFAULT_TTL_MS),
      tags: options.tags ?? [],
    });
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  exists(key: string): boolean {
    return this.isLive(this.store.get(key));
  }

  /** Deletes every key matching a `*`-glob pattern (e.g. "settings:*"). Returns the count removed. */
  clearPattern(pattern: string): number {
    const re = globToRegExp(pattern);
    let removed = 0;
    for (const key of this.store.keys()) {
      if (re.test(key)) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Alias for `delete` — reads better at call sites like `cache.invalidate(CacheKeys.settings())`. */
  invalidate(key: string): boolean {
    return this.delete(key);
  }

  /** Deletes every entry carrying any of the given tags. Returns the count removed. */
  invalidateTags(tags: string[]): number {
    if (tags.length === 0) return 0;
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.tags.some((t) => tags.includes(t))) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Cache-aside helper: return the cached value if present and live,
   * otherwise call `compute`, store its result, and return it. `compute` is
   * only invoked on a miss — the common way this cache actually gets used.
   */
  async remember<T>(key: string, compute: () => Promise<T>, options: CacheSetOptions = {}): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await compute();
    this.set(key, value, options);
    return value;
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRatio: total === 0 ? 0 : this.hits / total,
    };
  }
}

/** Process-wide singleton — one cache per warm function instance (see module doc). */
export const cache = new CacheManager();

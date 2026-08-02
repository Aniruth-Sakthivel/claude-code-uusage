import { beforeEach, describe, expect, it, vi } from "vitest";

import { CacheManager, DEFAULT_TTL_MS } from "./cache.js";

describe("CacheManager", () => {
  let cache: CacheManager;

  beforeEach(() => {
    cache = new CacheManager();
  });

  describe("get/set/delete/exists", () => {
    it("returns undefined for a key that was never set", () => {
      expect(cache.get("missing")).toBeUndefined();
      expect(cache.exists("missing")).toBe(false);
    });

    it("returns what was set", () => {
      cache.set("k", { a: 1 });
      expect(cache.get("k")).toEqual({ a: 1 });
      expect(cache.exists("k")).toBe(true);
    });

    it("delete removes the key and reports whether it existed", () => {
      cache.set("k", 1);
      expect(cache.delete("k")).toBe(true);
      expect(cache.get("k")).toBeUndefined();
      expect(cache.delete("k")).toBe(false);
    });
  });

  describe("TTL expiry", () => {
    it("expires an entry after its TTL, using the default when unset", () => {
      vi.useFakeTimers();
      try {
        cache.set("k", "v"); // default TTL
        vi.advanceTimersByTime(DEFAULT_TTL_MS - 1);
        expect(cache.get("k")).toBe("v");
        vi.advanceTimersByTime(2);
        expect(cache.get("k")).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("honors a custom TTL", () => {
      vi.useFakeTimers();
      try {
        cache.set("k", "v", { ttlMs: 1000 });
        vi.advanceTimersByTime(999);
        expect(cache.exists("k")).toBe(true);
        vi.advanceTimersByTime(2);
        expect(cache.exists("k")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("clearPattern", () => {
    it("removes keys matching a glob pattern and leaves others", () => {
      cache.set("dashboard:stats", 1);
      cache.set("dashboard:ranking", 2);
      cache.set("settings:fleet", 3);
      const removed = cache.clearPattern("dashboard:*");
      expect(removed).toBe(2);
      expect(cache.exists("dashboard:stats")).toBe(false);
      expect(cache.exists("dashboard:ranking")).toBe(false);
      expect(cache.exists("settings:fleet")).toBe(true);
    });

    it("supports an exact (no wildcard) pattern", () => {
      cache.set("exact", 1);
      cache.set("exactly-not", 2);
      expect(cache.clearPattern("exact")).toBe(1);
      expect(cache.exists("exactly-not")).toBe(true);
    });
  });

  describe("invalidate / invalidateTags", () => {
    it("invalidate deletes a single key", () => {
      cache.set("k", 1);
      expect(cache.invalidate("k")).toBe(true);
      expect(cache.exists("k")).toBe(false);
    });

    it("invalidateTags removes every entry sharing any of the given tags, leaving untagged/other-tagged entries", () => {
      cache.set("project:1", "a", { tags: ["project", "workspace:9"] });
      cache.set("projects:list", "b", { tags: ["project"] });
      cache.set("dashboard:stats", "c", { tags: ["dashboard"] });
      cache.set("untagged", "d");

      const removed = cache.invalidateTags(["project"]);

      expect(removed).toBe(2);
      expect(cache.exists("project:1")).toBe(false);
      expect(cache.exists("projects:list")).toBe(false);
      expect(cache.exists("dashboard:stats")).toBe(true);
      expect(cache.exists("untagged")).toBe(true);
    });

    it("invalidateTags with an empty array removes nothing", () => {
      cache.set("k", 1, { tags: ["t"] });
      expect(cache.invalidateTags([])).toBe(0);
      expect(cache.exists("k")).toBe(true);
    });
  });

  describe("remember", () => {
    it("computes and caches on a miss", async () => {
      const compute = vi.fn().mockResolvedValue("computed");
      const result = await cache.remember("k", compute);
      expect(result).toBe("computed");
      expect(compute).toHaveBeenCalledTimes(1);
    });

    it("returns the cached value on a hit without recomputing", async () => {
      const compute = vi.fn().mockResolvedValue("computed");
      await cache.remember("k", compute);
      const second = await cache.remember("k", compute);
      expect(second).toBe("computed");
      expect(compute).toHaveBeenCalledTimes(1);
    });

    it("recomputes after the entry expires", async () => {
      vi.useFakeTimers();
      try {
        const compute = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
        await cache.remember("k", compute, { ttlMs: 1000 });
        vi.advanceTimersByTime(1001);
        const result = await cache.remember("k", compute, { ttlMs: 1000 });
        expect(result).toBe("second");
        expect(compute).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("passes tags through to the underlying cache entry", async () => {
      await cache.remember("k", async () => "v", { tags: ["mytag"] });
      expect(cache.invalidateTags(["mytag"])).toBe(1);
    });
  });

  describe("stats", () => {
    it("tracks hits, misses, and hit ratio", () => {
      cache.set("k", 1);
      cache.get("k"); // hit
      cache.get("k"); // hit
      cache.get("missing"); // miss
      const stats = cache.stats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.size).toBe(1);
      expect(stats.hitRatio).toBeCloseTo(2 / 3);
    });

    it("reports a 0 hit ratio with no activity, not NaN", () => {
      expect(cache.stats().hitRatio).toBe(0);
    });
  });

  describe("clear", () => {
    it("empties the store and resets stats", () => {
      cache.set("k", 1);
      cache.get("k");
      cache.clear();
      expect(cache.stats()).toEqual({ size: 0, hits: 0, misses: 0, hitRatio: 0 });
    });
  });
});

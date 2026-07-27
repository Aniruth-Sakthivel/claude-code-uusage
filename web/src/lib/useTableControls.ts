/**
 * Client-side search + sort + pagination for table pages (Systems, Projects,
 * Sessions, Users, Audit). All these fetch their full result set already —
 * this is filtering/ordering/slicing that data in the browser, not a new
 * server round-trip. Once any of these lists grows large enough that
 * fetching everything is itself the bottleneck, this is the seam to swap for
 * server-side paging (same shape, different data source).
 */

import { useMemo, useState } from "react";

const PAGE_SIZE = 10;

export function useTableControls<T>(
  rows: T[] | undefined,
  opts: {
    /** Text this row is matched against (case-insensitive substring). */
    searchText: (row: T) => string;
    /** Named comparators — sortKey must be one of these keys to take effect. */
    sorters: Record<string, (a: T, b: T) => number>;
    initialSortKey?: string;
    initialSortDir?: "asc" | "desc";
    pageSize?: number;
  },
) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<string | undefined>(opts.initialSortKey);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(opts.initialSortDir ?? "asc");
  const [page, setPage] = useState(0);
  const pageSize = opts.pageSize ?? PAGE_SIZE;

  const filtered = useMemo(() => {
    const all = rows ?? [];
    if (!query.trim()) return all;
    const q = query.trim().toLowerCase();
    return all.filter((r) => opts.searchText(r).toLowerCase().includes(q));
  }, [rows, query, opts]);

  const sorted = useMemo(() => {
    if (!sortKey || !opts.sorters[sortKey]) return filtered;
    const cmp = opts.sorters[sortKey];
    const dirMul = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => cmp(a, b) * dirMul);
  }, [filtered, sortKey, sortDir, opts.sorters]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const paged = useMemo(
    () => sorted.slice(clampedPage * pageSize, clampedPage * pageSize + pageSize),
    [sorted, clampedPage, pageSize],
  );

  function toggleSort(key: string) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
    } else {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    }
    setPage(0);
  }

  return {
    query,
    setQuery: (q: string) => {
      setQuery(q);
      setPage(0);
    },
    sortKey,
    sortDir,
    toggleSort,
    page: clampedPage,
    setPage,
    pageCount,
    pageSize,
    total: sorted.length,
    rows: paged,
  };
}
